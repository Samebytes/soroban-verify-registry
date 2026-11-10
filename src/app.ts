import http from "node:http";
import { badgeSvg } from "./badge";
import type { ChainLookup } from "./chain";
import { ApiKeys, RateLimiter } from "./security";
import type { NewRecord, Status, Storage } from "./storage";

const CONTRACT_RE = /^C[A-Z2-7]{55}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/;
const MAX_BODY = 16 * 1024;

export interface AppOptions {
  /** When non-empty, POST /verifications requires a matching `x-api-key` header. */
  apiKeys?: string[];
  /** Per-key (or per-IP) request limit. Disabled when omitted. */
  rateLimit?: { limit: number; windowMs: number };
  /** Queue a server-side re-verification for every accepted submission. */
  reverify?: boolean;
  /** Test hook. */
  now?: () => number;
}

function send(res: http.ServerResponse, code: number, body: unknown, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(code, { "content-type": type, ...headers });
  res.end(type === "application/json" ? JSON.stringify(body) : String(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function parse(body: unknown): string | Omit<NewRecord, "created_at" | "trust"> {
  if (typeof body !== "object" || body === null) return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
  const contract_id = s("contract_id");
  const onchain_hash = s("onchain_hash").toLowerCase();
  const built_hash = s("built_hash").toLowerCase();
  const commit = s("commit").toLowerCase();
  const repo = s("repo");
  const status = s("status");
  if (!CONTRACT_RE.test(contract_id)) return "invalid contract_id";
  if (!HASH_RE.test(onchain_hash)) return "invalid onchain_hash";
  if (!HASH_RE.test(built_hash)) return "invalid built_hash";
  if (!COMMIT_RE.test(commit)) return "invalid commit";
  if (!repo || repo.length > 500) return "invalid repo";
  if (status !== "verified" && status !== "mismatch") return "invalid status";
  if ((status === "verified") !== (onchain_hash === built_hash)) {
    return "status is inconsistent with submitted hashes";
  }
  return {
    contract_id, onchain_hash, built_hash, commit, repo,
    status: status as Status,
    network: "testnet",
    source: s("source").slice(0, 64) || "unknown",
  };
}

export function createHandler(store: Storage, chain: ChainLookup, opts: AppOptions = {}): http.RequestListener {
  const keys = new ApiKeys(opts.apiKeys ?? []);
  const limiter = opts.rateLimit
    ? new RateLimiter(opts.rateLimit.limit, opts.rateLimit.windowMs, opts.now)
    : null;

  return async (req, res) => {
    try {
      // Rate limit first, so unauthenticated floods are throttled too. A valid API key gets its
      // own bucket; anything else (no key, or an unknown one) counts against the client IP, so
      // sending random x-api-key values cannot open fresh buckets.
      if (limiter) {
        const header = req.headers["x-api-key"];
        const keyIndex = keys.match(typeof header === "string" ? header : undefined);
        const id = keyIndex >= 0 ? `key:${keyIndex}` : `ip:${req.socket.remoteAddress ?? "?"}`;
        const wait = limiter.take(id);
        if (wait > 0) return send(res, 429, { error: "rate limit exceeded" }, "application/json", { "retry-after": String(wait) });
      }

      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (req.method === "POST" && path === "/verifications") {
        if (keys.enabled) {
          const h = req.headers["x-api-key"];
          if (!keys.check(typeof h === "string" ? h : undefined)) return send(res, 401, { error: "missing or invalid API key" });
        }
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return send(res, 400, { error: "invalid JSON" });
        }
        const parsed = parse(body);
        if (typeof parsed === "string") return send(res, 400, { error: parsed });

        // Never trust the submitted on-chain hash: compare against the real chain.
        const real = await chain.onchainHash(parsed.contract_id, parsed.network);
        if (real === null) return send(res, 404, { error: "contract not found on testnet" });
        if (real !== parsed.onchain_hash) {
          return send(res, 422, { error: "forged or stale onchain_hash", actual_onchain_hash: real });
        }
        const rec = { ...parsed, created_at: new Date().toISOString() };
        const id = await store.insert(rec);
        if (opts.reverify) await store.enqueue(id);
        return send(res, 201, { ...rec, trust: "self_reported", note: null, reverification: opts.reverify ? "queued" : "disabled" });
      }

      const contract = /^\/contracts\/([^/]+)$/.exec(path);
      if (req.method === "GET" && contract) {
        const id = contract[1] ?? "";
        const rec = CONTRACT_RE.test(id) ? await store.latest(id) : null;
        return rec ? send(res, 200, rec) : send(res, 404, { error: "unknown contract" });
      }

      const badge = /^\/badge\/([^/]+)\.svg$/.exec(path);
      if (req.method === "GET" && badge) {
        const id = badge[1] ?? "";
        const rec = CONTRACT_RE.test(id) ? await store.latest(id) : null;
        const svg = badgeSvg(rec ? rec.status : "unknown", rec?.trust === "self_reported");
        return send(res, 200, svg, "image/svg+xml");
      }

      send(res, 404, { error: "not found" });
    } catch {
      send(res, 500, { error: "internal error" });
    }
  };
}
