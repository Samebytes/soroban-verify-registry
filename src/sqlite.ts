import { DatabaseSync } from "node:sqlite";
import type { Job, NewRecord, ReverifyOutcome, Storage, VerificationRecord } from "./storage";

const COLS = `contract_id, network, repo, "commit", onchain_hash, built_hash, status, trust, source, note, created_at`;

export class SqliteStorage implements Storage {
  private db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS verifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contract_id TEXT NOT NULL, network TEXT NOT NULL, repo TEXT NOT NULL,
        "commit" TEXT NOT NULL, onchain_hash TEXT NOT NULL, built_hash TEXT NOT NULL,
        status TEXT NOT NULL, trust TEXT NOT NULL, source TEXT NOT NULL,
        note TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_contract ON verifications(contract_id, id);
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, id);`);
  }

  async insert(r: NewRecord): Promise<number> {
    const res = this.db
      .prepare(
        `INSERT INTO verifications (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.contract_id, r.network, r.repo, r.commit, r.onchain_hash, r.built_hash,
        r.status, r.trust ?? "self_reported", r.source, null, r.created_at,
      );
    return Number(res.lastInsertRowid);
  }

  async latest(contractId: string): Promise<VerificationRecord | null> {
    const row = this.db
      .prepare(`SELECT ${COLS} FROM verifications WHERE contract_id = ? ORDER BY id DESC LIMIT 1`)
      .get(contractId);
    return row ? ({ ...row } as unknown as VerificationRecord) : null;
  }

  async markReverified(recordId: number, o: ReverifyOutcome): Promise<void> {
    this.db
      .prepare(`UPDATE verifications SET status = ?, built_hash = ?, trust = 'reverified', note = ? WHERE id = ?`)
      .run(o.status, o.built_hash, o.note, recordId);
  }

  async enqueue(recordId: number): Promise<number> {
    const res = this.db.prepare(`INSERT INTO jobs (record_id) VALUES (?)`).run(recordId);
    return Number(res.lastInsertRowid);
  }

  async claimNext(): Promise<Job | null> {
    const row = this.db
      .prepare(
        `UPDATE jobs SET status = 'running'
         WHERE id = (SELECT id FROM jobs WHERE status = 'pending' ORDER BY id LIMIT 1)
         RETURNING id, record_id`,
      )
      .get() as { id: number; record_id: number } | undefined;
    if (!row) return null;
    const rec = this.db
      .prepare(`SELECT contract_id, repo, "commit", status AS claimed_status, built_hash AS claimed_built_hash FROM verifications WHERE id = ?`)
      .get(row.record_id) as Omit<Job, "job_id" | "record_id">;
    return { job_id: Number(row.id), record_id: Number(row.record_id), ...rec };
  }

  async finishJob(jobId: number, ok: boolean, error?: string): Promise<void> {
    this.db
      .prepare(`UPDATE jobs SET status = ?, error = ? WHERE id = ?`)
      .run(ok ? "done" : "failed", error ?? null, jobId);
  }

  async requeueRunning(): Promise<number> {
    const res = this.db.prepare(`UPDATE jobs SET status = 'pending' WHERE status = 'running'`).run();
    return Number(res.changes);
  }

  async pendingCount(): Promise<number> {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'`).get() as { n: number };
    return Number(row.n);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
