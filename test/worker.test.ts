import assert from "node:assert/strict";
import { test } from "node:test";
import { badgeSvg } from "../src/badge";
import { SqliteStorage } from "../src/sqlite";
import type { NewRecord } from "../src/storage";
import { CliReverifier, Worker, type Reverifier } from "../src/worker";

const CID = "C" + "A".repeat(55);
const H = "a".repeat(64);

const rec = (over: Partial<NewRecord> = {}): NewRecord => ({
  contract_id: CID, network: "testnet", repo: "https://github.com/a/b", commit: "abcdef1",
  onchain_hash: H, built_hash: H, status: "verified", source: "t",
  created_at: new Date().toISOString(), ...over,
});

async function queued(over: Partial<NewRecord> = {}) {
  const s = new SqliteStorage();
  await s.enqueue(await s.insert(rec(over)));
  return s;
}

test("worker re-runs the build and upgrades the record to reverified", async () => {
  const s = await queued();
  const r: Reverifier = { reverify: async () => ({ status: "verified", built_hash: H, onchain_hash: H }) };
  assert.equal(await new Worker(s, r).runOnce(), true);
  const l = await s.latest(CID);
  assert.equal(l?.trust, "reverified");
  assert.equal(l?.note, null);
  assert.equal(await new Worker(s, r).runOnce(), false, "queue is drained");
});

test("a false claim is overwritten by the server result and flagged", async () => {
  // Submitter claimed "verified", but the server's own rebuild does not match.
  const s = await queued();
  const bad = "b".repeat(64);
  const r: Reverifier = { reverify: async () => ({ status: "mismatch", built_hash: bad, onchain_hash: H }) };
  await new Worker(s, r).runOnce();
  const l = await s.latest(CID);
  assert.equal(l?.trust, "reverified");
  assert.equal(l?.status, "mismatch");
  assert.equal(l?.built_hash, bad);
  assert.match(l?.note ?? "", /differed/);
});

test("a failed re-run leaves the record self_reported and does not crash the worker", async () => {
  const s = await queued();
  const r: Reverifier = { reverify: async () => { throw new Error("docker unavailable"); } };
  const logs: string[] = [];
  assert.equal(await new Worker(s, r, (m) => logs.push(m)).runOnce(), true);
  assert.equal((await s.latest(CID))?.trust, "self_reported");
  assert.match(logs[0] ?? "", /docker unavailable/);
  assert.equal(await s.pendingCount(), 0, "failed jobs are not retried forever");
});

test("the CLI reverifier refuses non-GitHub repos (no local paths or other schemes)", async () => {
  const rv = new CliReverifier("definitely-not-a-binary");
  for (const repo of ["/etc", "file:///etc/passwd", "http://github.com/a/b", "https://evil.example/a/b", "--upload-pack=x"]) {
    await assert.rejects(rv.reverify({ contract_id: CID, repo, commit: "abcdef1" }), /public https:\/\/github\.com/);
  }
});

test("badge drops the self-reported label only once reverified", () => {
  assert.match(badgeSvg("verified", true), /verified \(self-reported\)/);
  const full = badgeSvg("verified", false);
  assert.match(full, />verified</);
  assert.doesNotMatch(full, /self-reported/);
});
