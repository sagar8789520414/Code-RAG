export class AppError extends Error {
  constructor(
    message: string,
    readonly status = 500,
    readonly code = "internal_error",
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super(`${what} not found`, 404, "not_found");
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, "bad_request", details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, "conflict");
  }
}

/** Why a provider call failed; drives retry, circuit breaking, and fallback decisions. */
export type ProviderFailureKind = "rate_limit" | "server_error" | "context_overflow" | "timeout" | "network" | "bad_request" | "auth" | "aborted";

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly kind: ProviderFailureKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(`${provider}: ${message}`);
    this.name = "ProviderError";
  }

  /** Failures that indicate provider health problems (vs. a bad request or a cancelled call). */
  get countsAgainstHealth(): boolean {
    return this.kind === "rate_limit" || this.kind === "server_error" || this.kind === "timeout" || this.kind === "network" || this.kind === "auth";
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) ||
    (err instanceof ProviderError && err.kind === "aborted")
  );
}
