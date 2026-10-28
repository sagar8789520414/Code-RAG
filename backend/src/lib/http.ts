import { ProviderError, type ProviderFailureKind } from "./errors.js";

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Parses `Retry-After` (seconds or HTTP date) plus Gemini's `RetryInfo.retryDelay` ("12s"). */
export function parseRetryAfter(headers: Headers, body?: string): number | undefined {
  const h = headers.get("retry-after");
  if (h) {
    const secs = Number(h);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const date = Date.parse(h);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const m = body?.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (m?.[1]) return Number(m[1]) * 1000;
  return undefined;
}

const CONTEXT_OVERFLOW = /context[_ ]length|context window|too many tokens|maximum context|reduce the length|request too large|input token count|exceeds the maximum/i;

export function classifyHttpFailure(status: number, body: string): ProviderFailureKind {
  if (status === 413 || CONTEXT_OVERFLOW.test(body)) return "context_overflow";
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "server_error";
  return "bad_request";
}

/** Combines an optional caller signal with a per-request timeout. */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** fetch wrapper that converts transport/HTTP failures into typed ProviderErrors. */
export async function providerFetch(
  provider: string,
  url: string,
  init: RequestInit & { timeoutMs: number; callerSignal?: AbortSignal; headersTimeoutMs?: number },
): Promise<Response> {
  const { timeoutMs, callerSignal, headersTimeoutMs, ...rest } = init;
  // Streaming endpoints send headers immediately; an overloaded upstream that doesn't
  // should fail fast so the next model/provider can be tried.
  const headerCtl = new AbortController();
  const headerTimer = headersTimeoutMs
    ? setTimeout(() => headerCtl.abort(new DOMException(`no response headers after ${headersTimeoutMs}ms`, "TimeoutError")), headersTimeoutMs)
    : undefined;
  let res: Response;
  try {
    res = await fetch(url, { ...rest, signal: AbortSignal.any([withTimeout(callerSignal, timeoutMs), headerCtl.signal]) });
  } catch (err) {
    if (callerSignal?.aborted) throw new ProviderError(provider, "aborted", "request cancelled");
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new ProviderError(provider, "timeout", headerCtl.signal.aborted ? `no response headers after ${headersTimeoutMs}ms` : `request timed out after ${timeoutMs}ms`);
    }
    throw new ProviderError(provider, "network", err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(headerTimer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const kind = classifyHttpFailure(res.status, body);
    throw new ProviderError(provider, kind, `HTTP ${res.status}: ${body.slice(0, 300)}`, res.status, parseRetryAfter(res.headers, body));
  }
  return res;
}

export interface RetryOptions {
  retries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  shouldRetry?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

/** Exponential backoff with full jitter; honours provider-supplied retry-after hints. */
export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 20_000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const retryable = opts.shouldRetry ? opts.shouldRetry(err) : true;
      if (attempt >= opts.retries || !retryable || opts.signal?.aborted) throw err;
      const hinted = err instanceof ProviderError ? err.retryAfterMs : undefined;
      const delay = Math.min(max, hinted ?? Math.random() * base * 2 ** attempt + base / 2);
      opts.onRetry?.(err, attempt + 1, delay);
      await sleep(delay, opts.signal);
    }
  }
}

/**
 * Reads an SSE/`data:` line stream from a fetch Response body. Fails with a timeout
 * ProviderError if the upstream goes silent for `idleMs` (stalled generation).
 */
export async function* readSseData(res: Response, opts: { provider: string; signal?: AbortSignal; idleMs?: number }): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const idleMs = opts.idleMs ?? 30_000;
  let buffer = "";
  const read = async () => {
    let timer: NodeJS.Timeout | undefined;
    const idle = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProviderError(opts.provider, "timeout", `stream idle for ${idleMs}ms`)), idleMs);
    });
    try {
      return await Promise.race([reader.read(), idle]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    while (true) {
      if (opts.signal?.aborted) throw new ProviderError(opts.provider, "aborted", "request cancelled");
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await read();
      } catch (err) {
        await reader.cancel().catch(() => undefined);
        if (opts.signal?.aborted) throw new ProviderError(opts.provider, "aborted", "request cancelled");
        if (err instanceof ProviderError) throw err;
        throw new ProviderError(opts.provider, "network", `stream interrupted: ${err instanceof Error ? err.message : String(err)}`);
      }
      const { done, value } = chunk;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line.startsWith("data:")) yield line.slice(5).trimStart();
      }
    }
    if (buffer.startsWith("data:")) yield buffer.slice(5).trimStart();
  } finally {
    reader.releaseLock();
  }
}
