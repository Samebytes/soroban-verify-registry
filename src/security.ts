import { createHash, timingSafeEqual } from "node:crypto";

/** API keys (wave: registry-2). Only SHA-256 digests are kept in memory. */
export class ApiKeys {
  private digests: Buffer[];

  constructor(keys: string[]) {
    this.digests = keys.filter(Boolean).map((k) => createHash("sha256").update(k).digest());
  }

  get enabled(): boolean {
    return this.digests.length > 0;
  }

  check(key: string | undefined): boolean {
    return this.match(key) !== -1;
  }

  /** Index of the configured key that `key` matches, or -1. Never exposes the key itself. */
  match(key: string | undefined): number {
    if (!key) return -1;
    const d = createHash("sha256").update(key).digest();
    // Compare against every digest (no early exit) to keep timing independent of which key matched.
    let found = -1;
    this.digests.forEach((known, i) => {
      if (timingSafeEqual(known, d)) found = i;
    });
    return found;
  }
}

/** Fixed-window rate limiter keyed by API key or client IP (wave: registry-2). */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private limit: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  /** Returns 0 if allowed, otherwise the seconds until the window resets. */
  take(key: string): number {
    const t = this.now();
    if (this.hits.size > 10_000) this.sweep(t);
    const h = this.hits.get(key);
    if (!h || h.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      return 0;
    }
    if (h.count >= this.limit) return Math.max(1, Math.ceil((h.resetAt - t) / 1000));
    h.count++;
    return 0;
  }

  private sweep(t: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}
