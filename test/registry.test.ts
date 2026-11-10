import assert from "node:assert/strict";
import http from "node:http";
import { after, describe, test } from "node:test";
import { createHandler, type AppOptions } from "../src/app";
import type { ChainLookup } from "../src/chain";
import { SqliteStorage } from "../src/sqlite";
import type { Storage } from "../src/storage";

const CID = "C" + "A".repeat(55);
const OTHER = "C" + "B".repeat(55);
const REAL = "a".repeat(64);
const COMMIT = "abcdef1234567";

const chain: ChainLookup = { onchainHash: async (id) => (id === CID ? REAL : null) };

const servers: http.Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function start(opts: AppOptions = {}, store: Storage = new SqliteStorage()) {
  const server = http.createServer(createHandler(store, chain, opts));
  await new Promise<void>((r) => server.listen(0, r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/verifications`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { base, post, store };
}

const good = {
  contract_id: CID, repo: "https://github.com/a/b", commit: COMMIT,
  onchain_hash: REAL, built_hash: REAL, status: "verified", source: "cli",
};

describe("core API", () => {
  test("submit then fetch returns a self-reported record", async () => {
    const { base, post } = await start();
    assert.equal((await post(good)).status, 201);
    const g = await fetch(`${base}/contracts/${CID}`);
    assert.equal(g.status, 200);
    const rec = (await g.json()) as Record<string, string>;
    assert.equal(rec.status, "verified");
    assert.equal(rec.trust, "self_reported");
  });

  test("unknown contract returns 404 for fetch and an unknown badge", async () => {
    const { base } = await start();
    assert.equal((await fetch(`${base}/contracts/${OTHER}`)).status, 404);
    const b = await fetch(`${base}/badge/${OTHER}.svg`);
    assert.equal(b.status, 200);
    assert.match(await b.text(), /unknown/);
  });

  test("submission for a contract that is not on chain is rejected", async () => {
    const { post } = await start();
    assert.equal((await post({ ...good, contract_id: OTHER })).status, 404);
  });

  test("forged on-chain hash is rejected", async () => {
    const { post } = await start();
    const fake = "f".repeat(64);
    assert.equal((await post({ ...good, onchain_hash: fake, built_hash: fake })).status, 422);
  });

  test("status inconsistent with hashes is rejected", async () => {
    const { post } = await start();
    assert.equal((await post({ ...good, built_hash: "c".repeat(64) })).status, 400);
  });

  test("badge reflects verified self-reported state", async () => {
    const { base, post } = await start();
    await post(good);
    const b = await fetch(`${base}/badge/${CID}.svg`);
    assert.equal(b.headers.get("content-type"), "image/svg+xml");
    assert.match(await b.text(), /verified \(self-reported\)/);
  });

  test("malformed JSON returns 400", async () => {
    const { base } = await start();
    assert.equal((await fetch(`${base}/verifications`, { method: "POST", body: "{nope" })).status, 400);
  });
});

describe("API keys (registry-2)", () => {
  test("POST needs a valid key when keys are configured; GET stays public", async () => {
    const { base, post } = await start({ apiKeys: ["s3cret"] });
    assert.equal((await post(good)).status, 401);
    assert.equal((await post(good, { "x-api-key": "wrong" })).status, 401);
    assert.equal((await post(good, { "x-api-key": "s3cret" })).status, 201);
    assert.equal((await fetch(`${base}/contracts/${CID}`)).status, 200);
  });
});

describe("rate limiting (registry-2)", () => {
  test("requests over the limit get 429 with Retry-After, and the window resets", async () => {
    let t = 1_000_000;
    const { base } = await start({ rateLimit: { limit: 3, windowMs: 60_000 }, now: () => t });
    for (let i = 0; i < 3; i++) assert.equal((await fetch(`${base}/contracts/${OTHER}`)).status, 404);
    const limited = await fetch(`${base}/contracts/${OTHER}`);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    t += 61_000;
    assert.equal((await fetch(`${base}/contracts/${OTHER}`)).status, 404);
  });

  test("limits are tracked per valid API key", async () => {
    const { base } = await start({ apiKeys: ["a", "b"], rateLimit: { limit: 1, windowMs: 60_000 } });
    const get = (k: string) => fetch(`${base}/contracts/${OTHER}`, { headers: { "x-api-key": k } });
    assert.equal((await get("a")).status, 404);
    assert.equal((await get("a")).status, 429);
    assert.equal((await get("b")).status, 404);
  });

  test("random or unknown API keys cannot open fresh buckets", async () => {
    const { base } = await start({ apiKeys: ["a"], rateLimit: { limit: 2, windowMs: 60_000 } });
    const get = (k: string) => fetch(`${base}/contracts/${OTHER}`, { headers: { "x-api-key": k } });
    assert.equal((await get("random-1")).status, 404);
    assert.equal((await fetch(`${base}/contracts/${OTHER}`)).status, 404);
    assert.equal((await get("random-2")).status, 429, "unknown keys share the caller's IP bucket");
    assert.equal((await get("a")).status, 404, "a valid key still has its own bucket");
  });

  test("without configured keys every caller is limited by IP", async () => {
    const { base } = await start({ rateLimit: { limit: 1, windowMs: 60_000 } });
    const get = (k: string) => fetch(`${base}/contracts/${OTHER}`, { headers: { "x-api-key": k } });
    assert.equal((await get("x")).status, 404);
    assert.equal((await get("y")).status, 429);
  });
});

describe("reverification queue (registry-3)", () => {
  test("accepted submissions are queued when reverify is on", async () => {
    const { post, store } = await start({ reverify: true });
    const r = await post(good);
    assert.equal(r.status, 201);
    assert.equal(((await r.json()) as { reverification: string }).reverification, "queued");
    assert.equal(await store.pendingCount(), 1);
  });

  test("nothing is queued when reverify is off", async () => {
    const { post, store } = await start();
    await post(good);
    assert.equal(await store.pendingCount(), 0);
  });
});
