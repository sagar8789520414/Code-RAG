export type BreakerState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Consecutive health failures that trip the breaker. */
  failureThreshold: number;
  /** How long the breaker stays open before allowing a trial request. */
  cooldownMs: number;
  now?: () => number;
}

/**
 * Classic three-state circuit breaker. Callers ask `canRequest()` before calling the
 * provider and report the outcome; while open, traffic is routed to the fallback.
 */
export class CircuitBreaker {
  private state: BreakerState = "closed";
  private failures = 0;
  private openedAt = 0;
  private openForMs: number;
  private trialInFlight = false;
  private readonly now: () => number;
  lastError?: string;

  constructor(
    readonly name: string,
    private readonly opts: CircuitBreakerOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.openForMs = opts.cooldownMs;
  }

  canRequest(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (this.now() - this.openedAt < this.openForMs) return false;
      this.state = "half_open";
      this.trialInFlight = false;
    }
    // half-open: allow exactly one trial request at a time
    if (this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.state = "closed";
    this.failures = 0;
    this.trialInFlight = false;
    this.openForMs = this.opts.cooldownMs;
  }

  /** @param retryAfterMs provider hint (e.g. 429 Retry-After) that extends the open window. */
  recordFailure(message: string, retryAfterMs?: number): void {
    this.lastError = message;
    this.failures++;
    this.trialInFlight = false;
    if (this.state === "half_open" || this.failures >= this.opts.failureThreshold || retryAfterMs !== undefined) {
      this.state = "open";
      this.openedAt = this.now();
      this.openForMs = Math.max(this.opts.cooldownMs, retryAfterMs ?? 0);
    }
  }

  /** A non-health failure (bad request, abort) must still release a half-open trial slot. */
  releaseTrial(): void {
    this.trialInFlight = false;
  }

  snapshot() {
    const state = this.state === "open" && this.now() - this.openedAt >= this.openForMs ? "half_open" : this.state;
    return {
      name: this.name,
      state,
      consecutiveFailures: this.failures,
      reopensInMs: state === "open" ? Math.max(0, this.openForMs - (this.now() - this.openedAt)) : 0,
      lastError: this.lastError,
    };
  }
}
