import http from "node:http";
import { createHandler } from "./app";
import { StellarCliChain } from "./chain";
import { PostgresStorage } from "./postgres";
import { SqliteStorage } from "./sqlite";
import type { Storage } from "./storage";
import { CliReverifier, Worker } from "./worker";

/**
 * Environment:
 *  PORT, DB_PATH (sqlite file) or DATABASE_URL (postgres)
 *  API_KEYS=key1,key2        required for POST unless ALLOW_ANONYMOUS=1
 *  RATE_LIMIT=60             requests per RATE_WINDOW_SECONDS (default 60) per key/IP; 0 disables
 *  REVERIFY=1                run the server-side re-verification worker (needs docker, git, soroban-verify)
 */
async function main() {
  const apiKeys = (process.env.API_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  if (apiKeys.length === 0 && process.env.ALLOW_ANONYMOUS !== "1") {
    console.error("Refusing to start: set API_KEYS, or ALLOW_ANONYMOUS=1 to accept unauthenticated submissions.");
    process.exit(1);
  }
  const store: Storage = process.env.DATABASE_URL
    ? await PostgresStorage.connect(process.env.DATABASE_URL)
    : new SqliteStorage(process.env.DB_PATH ?? "registry.db");

  const limit = Number(process.env.RATE_LIMIT ?? 60);
  const reverify = process.env.REVERIFY === "1";
  const handler = createHandler(store, new StellarCliChain(), {
    apiKeys,
    reverify,
    rateLimit: limit > 0 ? { limit, windowMs: Number(process.env.RATE_WINDOW_SECONDS ?? 60) * 1000 } : undefined,
  });

  const port = Number(process.env.PORT ?? 3000);
  const server = http.createServer(handler).listen(port, () => {
    console.log(`soroban-verify-registry listening on :${port} (reverify ${reverify ? "on" : "off"})`);
  });

  const worker = reverify ? new Worker(store, new CliReverifier(), console.error) : null;
  await worker?.start();

  const shutdown = async () => {
    worker?.stop();
    server.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
