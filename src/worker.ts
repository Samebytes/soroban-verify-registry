import { execFile } from "node:child_process";
import type { Job, Storage } from "./storage";

export interface ReverifyResult {
  status: "verified" | "mismatch";
  built_hash: string;
  onchain_hash: string;
}

/** Re-runs a verification server-side (wave: registry-3). */
export interface Reverifier {
  reverify(job: Pick<Job, "contract_id" | "repo" | "commit">): Promise<ReverifyResult>;
}

/** Only public GitHub repos are cloned server-side (SEP-55 is GitHub-only); no local paths or other schemes. */
const GITHUB_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(\.git)?$/;

/** Default: shells out to the `soroban-verify` CLI and reads its JSON result. */
export class CliReverifier implements Reverifier {
  constructor(private bin = "soroban-verify", private timeoutMs = 30 * 60_000) {}

  reverify(job: Pick<Job, "contract_id" | "repo" | "commit">): Promise<ReverifyResult> {
    if (!GITHUB_RE.test(job.repo)) {
      return Promise.reject(new Error("repo is not a public https://github.com/<owner>/<repo> URL"));
    }
    return new Promise((resolve, reject) => {
      execFile(
        this.bin,
        ["verify", job.contract_id, "--repo", job.repo, "--commit", job.commit, "--json"],
        { timeout: this.timeoutMs, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          // Exit code 1 (mismatch) still prints a valid JSON result.
          try {
            const j = JSON.parse(String(stdout)) as ReverifyResult & { message?: string };
            if (j.status === "verified" || j.status === "mismatch") return resolve(j);
            return reject(new Error(j.message ?? "CLI error"));
          } catch {
            reject(new Error(String(stderr || err?.message || "CLI produced no JSON")));
          }
        },
      );
    });
  }
}

/** Processes the persistent job queue one job at a time. */
export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private storage: Storage,
    private reverifier: Reverifier,
    private log: (m: string) => void = () => {},
  ) {}

  /** Handles at most one job. Returns false when the queue is empty. */
  async runOnce(): Promise<boolean> {
    const job = await this.storage.claimNext();
    if (!job) return false;
    try {
      const res = await this.reverifier.reverify(job);
      const claimedDiffers =
        job.claimed_status !== res.status || job.claimed_built_hash !== res.built_hash;
      await this.storage.markReverified(job.record_id, {
        status: res.status,
        built_hash: res.built_hash,
        note: claimedDiffers ? "server re-run differed from the submitted claim; server result stored" : null,
      });
      await this.storage.finishJob(job.job_id, true);
    } catch (e) {
      // The record stays "self_reported"; the failure is kept on the job row.
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`job ${job.job_id} failed: ${msg}`);
      await this.storage.finishJob(job.job_id, false, msg);
    }
    return true;
  }

  async start(intervalMs = 2000): Promise<void> {
    await this.storage.requeueRunning();
    const tick = async () => {
      if (this.busy) return;
      this.busy = true;
      try {
        while (await this.runOnce()) {
          /* drain */
        }
      } catch (e) {
        this.log(`worker error: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.busy = false;
      }
    };
    this.timer = setInterval(tick, intervalMs);
    void tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
