export type Trust = "self_reported" | "reverified";
export type Status = "verified" | "mismatch";

/** Public record shape returned by the API. */
export interface VerificationRecord {
  contract_id: string;
  network: string;
  repo: string;
  commit: string;
  onchain_hash: string;
  built_hash: string;
  status: Status;
  /** "self_reported" until the server-side worker re-runs the build ("reverified"). */
  trust: Trust;
  source: string;
  /** Set when re-verification changed the submitted claim. */
  note: string | null;
  created_at: string;
}

export type NewRecord = Omit<VerificationRecord, "trust" | "note"> & {
  trust?: Trust;
};

export interface Job {
  job_id: number;
  record_id: number;
  contract_id: string;
  repo: string;
  commit: string;
  /** What the submitter claimed, to detect a differing server-side result. */
  claimed_status: Status;
  claimed_built_hash: string;
}

export interface ReverifyOutcome {
  status: Status;
  built_hash: string;
  note: string | null;
}

/**
 * Storage backend contract (wave: registry-1). Implemented by SQLite and Postgres; both are
 * exercised by the same test suite (test/storage.test.ts).
 */
export interface Storage {
  insert(r: NewRecord): Promise<number>;
  latest(contractId: string): Promise<VerificationRecord | null>;
  markReverified(recordId: number, outcome: ReverifyOutcome): Promise<void>;
  /** Queue a server-side re-verification for a stored record. */
  enqueue(recordId: number): Promise<number>;
  /** Atomically claim the oldest pending job, or null. */
  claimNext(): Promise<Job | null>;
  finishJob(jobId: number, ok: boolean, error?: string): Promise<void>;
  /** Jobs left "running" by a crashed worker go back to pending. */
  requeueRunning(): Promise<number>;
  pendingCount(): Promise<number>;
  close(): Promise<void>;
}
