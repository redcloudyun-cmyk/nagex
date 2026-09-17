// R13 Identity & Account Lifecycle — Rate Limiter
export interface RateLimiterOptions {
  windowMs?: number;   // e.g. 15 minutes (900,000 ms)
  maxHits?: number;    // e.g. 5 attempts per window
}

export class IdentityRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxHits: number;

  constructor(options: RateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 15 * 60 * 1000;
    this.maxHits = options.maxHits ?? 5;
  }

  public check(key: string, nowMs = Date.now()): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const timestamps = (this.hits.get(key) || []).filter((t) => nowMs - t < this.windowMs);
    if (timestamps.length >= this.maxHits) {
      const oldest = timestamps[0];
      const retryAfterMs = Math.max(0, oldest + this.windowMs - nowMs);
      return { allowed: false, remaining: 0, retryAfterMs };
    }
    return { allowed: true, remaining: this.maxHits - timestamps.length, retryAfterMs: 0 };
  }

  public record(key: string, nowMs = Date.now()): void {
    const timestamps = (this.hits.get(key) || []).filter((t) => nowMs - t < this.windowMs);
    timestamps.push(nowMs);
    this.hits.set(key, timestamps);
  }

  public reset(key: string): void {
    this.hits.delete(key);
  }
}
