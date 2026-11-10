import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PostgresStorage } from "../src/postgres";
import { SqliteStorage } from "../src/sqlite";
import type { NewRecord, Storage } from "../src/storage";

const CID = "C" + "A".repeat(55);
const H = "a".repeat(64);

const rec = (over: Partial<NewRecord> = {}): NewRecord => ({
  contract_id: CID, network: "testnet", repo: "https://github.com/a/b", commit: "abcdef1",
  onchain_hash: H, built_hash: H, status: "verified", source: "t",
  created_at: new Date().toISOString(), ...over,
});

/** The same behavioural suite runs against every Storage backend. */
function suite(name: string, make: () => Promise<Storage>) {
  describe(`storage: ${name}`, () => {
    test("insert then latest returns the newest record, self_reported", async () => {
      const s = await make();
      await s.insert(rec({ commit: "1111111" }));
      await s.insert(rec({ commit: "2222222" }));
      const l = await s.latest(CID);
      assert.equal(l?.commit, "2222222");
      assert.equal(l?.trust, "self_reported");
      assert.equal(l?.note, null);
      assert.equal(await s.latest("C" + "B".repeat(55)), null);
      await s.close();
    });

    test("queue: claim is FIFO, atomic, and carries the claim", async () => {
      const s = await make();
      const a = await s.insert(rec({ commit: "aaaaaaa" }));
      const b = await s.insert(rec({ commit: "bbbbbbb" }));
      await s.enqueue(a);
      await s.enqueue(b);
      assert.equal(await s.pendingCount(), 2);
      const j1 = await s.claimNext();
      const j2 = await s.claimNext();
      assert.equal(j1?.commit, "aaaaaaa");
      assert.equal(j1?.claimed_status, "verified");
      assert.equal(j2?.commit, "bbbbbbb");
      assert.equal(await s.claimNext(), null);
      assert.equal(await s.pendingCount(), 0);
      await s.close();
    });

    test("requeueRunning returns crashed jobs to pending", async () => {
      const s = await make();
      await s.enqueue(await s.insert(rec()));
      await s.claimNext();
      assert.equal(await s.requeueRunning(), 1);
      assert.equal(await s.pendingCount(), 1);
      await s.close();
    });

    test("markReverified updates the stored record", async () => {
      const s = await make();
      const id = await s.insert(rec());
      await s.markReverified(id, { status: "mismatch", built_hash: "b".repeat(64), note: "differed" });
      const l = await s.latest(CID);
      assert.equal(l?.trust, "reverified");
      assert.equal(l?.status, "mismatch");
      assert.equal(l?.built_hash, "b".repeat(64));
      assert.equal(l?.note, "differed");
      await s.close();
    });
  });
}

suite("sqlite", async () => new SqliteStorage());

const pg = process.env.PG_URL;
if (pg) {
  suite("postgres", async () => {
    const s = await PostgresStorage.connect(pg);
    // Fresh state per test: the suite shares one database.
    const { Pool } = await import("pg");
    const p = new Pool({ connectionString: pg });
    await p.query("TRUNCATE verifications, jobs RESTART IDENTITY");
    await p.end();
    return s;
  });
} else {
  test("postgres storage suite (skipped: set PG_URL to run)", { skip: true }, () => {});
}
