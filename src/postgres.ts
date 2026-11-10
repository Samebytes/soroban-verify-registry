import { Pool } from "pg";
import type { Job, NewRecord, ReverifyOutcome, Storage, VerificationRecord } from "./storage";

const COLS = `contract_id, network, repo, "commit", onchain_hash, built_hash, status, trust, source, note, created_at`;

/** Postgres adapter (wave: registry-1). Same behaviour as SqliteStorage. */
export class PostgresStorage implements Storage {
  private constructor(private pool: Pool) {}

  static async connect(connectionString: string): Promise<PostgresStorage> {
    const s = new PostgresStorage(new Pool({ connectionString }));
    await s.pool.query(`
      CREATE TABLE IF NOT EXISTS verifications (
        id BIGSERIAL PRIMARY KEY,
        contract_id TEXT NOT NULL, network TEXT NOT NULL, repo TEXT NOT NULL,
        "commit" TEXT NOT NULL, onchain_hash TEXT NOT NULL, built_hash TEXT NOT NULL,
        status TEXT NOT NULL, trust TEXT NOT NULL, source TEXT NOT NULL,
        note TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_contract ON verifications(contract_id, id);
      CREATE TABLE IF NOT EXISTS jobs (
        id BIGSERIAL PRIMARY KEY,
        record_id BIGINT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, id);`);
    return s;
  }

  async insert(r: NewRecord): Promise<number> {
    const res = await this.pool.query(
      `INSERT INTO verifications (${COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [r.contract_id, r.network, r.repo, r.commit, r.onchain_hash, r.built_hash,
       r.status, r.trust ?? "self_reported", r.source, null, r.created_at],
    );
    return Number(res.rows[0].id);
  }

  async latest(contractId: string): Promise<VerificationRecord | null> {
    const res = await this.pool.query(
      `SELECT ${COLS} FROM verifications WHERE contract_id = $1 ORDER BY id DESC LIMIT 1`,
      [contractId],
    );
    return (res.rows[0] as VerificationRecord | undefined) ?? null;
  }

  async markReverified(recordId: number, o: ReverifyOutcome): Promise<void> {
    await this.pool.query(
      `UPDATE verifications SET status = $1, built_hash = $2, trust = 'reverified', note = $3 WHERE id = $4`,
      [o.status, o.built_hash, o.note, recordId],
    );
  }

  async enqueue(recordId: number): Promise<number> {
    const res = await this.pool.query(`INSERT INTO jobs (record_id) VALUES ($1) RETURNING id`, [recordId]);
    return Number(res.rows[0].id);
  }

  async claimNext(): Promise<Job | null> {
    const res = await this.pool.query(
      `UPDATE jobs SET status = 'running'
       WHERE id = (SELECT id FROM jobs WHERE status = 'pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING id, record_id`,
    );
    const row = res.rows[0];
    if (!row) return null;
    const rec = await this.pool.query(
      `SELECT contract_id, repo, "commit", status AS claimed_status, built_hash AS claimed_built_hash FROM verifications WHERE id = $1`,
      [row.record_id],
    );
    return { job_id: Number(row.id), record_id: Number(row.record_id), ...rec.rows[0] };
  }

  async finishJob(jobId: number, ok: boolean, error?: string): Promise<void> {
    await this.pool.query(`UPDATE jobs SET status = $1, error = $2 WHERE id = $3`, [
      ok ? "done" : "failed",
      error ?? null,
      jobId,
    ]);
  }

  async requeueRunning(): Promise<number> {
    const res = await this.pool.query(`UPDATE jobs SET status = 'pending' WHERE status = 'running'`);
    return res.rowCount ?? 0;
  }

  async pendingCount(): Promise<number> {
    const res = await this.pool.query(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'`);
    return Number(res.rows[0].n);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
