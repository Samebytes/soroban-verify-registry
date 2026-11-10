import { execFile } from "node:child_process";

/** Looks up the real on-chain WASM hash. Returns null when the contract does not exist. */
export interface ChainLookup {
  onchainHash(contractId: string, network: string): Promise<string | null>;
}

/** Default implementation: shells out to `stellar contract info hash`. */
export class StellarCliChain implements ChainLookup {
  onchainHash(contractId: string, network: string): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(
        "stellar",
        ["contract", "info", "hash", "--id", contractId, "--network", network],
        { timeout: 30_000 },
        (err, stdout) => {
          const h = String(stdout).trim().toLowerCase();
          resolve(!err && /^[0-9a-f]{64}$/.test(h) ? h : null);
        },
      );
    });
  }
}
