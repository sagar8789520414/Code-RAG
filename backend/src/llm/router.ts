import { CircuitBreaker } from "../lib/circuitBreaker.js";
import { ProviderError, errorMessage, isAbortError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { estimateTokens } from "../lib/text.js";
import { GeminiProvider } from "./gemini.js";
import { GroqProvider } from "./groq.js";
import type { CompletionRequest, CompletionResult, LLMCallRecord, LLMProvider } from "./types.js";

export class LLMUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMUnavailableError";
  }
}

/**
 * Routes each request to the primary provider (Groq, low latency) and falls back to the
 * secondary (Gemini, large context) when:
 *   - the prompt would not fit the primary's context window,
 *   - the primary's circuit breaker is open after repeated failures / rate limits, or
 *   - the primary call fails (429, 5xx, timeout, context overflow, invalid output).
 * Streams can only fall back before the first token has been emitted.
 */
export class LLMRouter {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly primary: LLMProvider,
    private readonly fallback: LLMProvider,
  ) {
    for (const p of [primary, fallback]) this.breakers.set(p.name, new CircuitBreaker(p.name, { failureThreshold: 3, cooldownMs: 30_000 }));
  }

  complete(req: CompletionRequest, trace?: LLMCallRecord[]): Promise<CompletionResult> {
    return this.run(req, trace, (p) => p.complete(req), () => true);
  }

  /**
   * JSON completion validated by `parse`. Output that fails parsing/validation counts as a
   * primary failure, so the request is retried once on the fallback provider.
   */
  async completeJson<T>(req: CompletionRequest, parse: (value: unknown) => T, trace?: LLMCallRecord[]): Promise<{ value: T; result: CompletionResult }> {
    const jsonReq = { ...req, json: true };
    const result = await this.complete(jsonReq, trace);
    try {
      return { value: parse(parseJsonLoose(result.text)), result };
    } catch (err) {
      if (result.provider === this.fallback.name) throw err;
      trace?.push({ purpose: req.purpose, provider: result.provider, model: result.model, ok: false, latencyMs: 0, error: `invalid JSON output: ${errorMessage(err).slice(0, 160)}` });
      const retried = await this.run(jsonReq, trace, (p) => p.complete(jsonReq), () => true, "invalid_output");
      return { value: parse(parseJsonLoose(retried.text)), result: retried };
    }
  }

  stream(req: CompletionRequest, onDelta: (text: string) => void, trace?: LLMCallRecord[]): Promise<CompletionResult> {
    let emitted = false;
    const wrapped = (t: string) => {
      emitted = true;
      onDelta(t);
    };
    return this.run(
      req,
      trace,
      (p) => p.stream(req, wrapped),
      () => !emitted,
    );
  }

  health() {
    return [...this.breakers.values()].map((b) => b.snapshot());
  }

  private breaker(p: LLMProvider): CircuitBreaker {
    return this.breakers.get(p.name) as CircuitBreaker;
  }

  private async attempt(p: LLMProvider, req: CompletionRequest, invoke: (p: LLMProvider) => Promise<CompletionResult>, trace: LLMCallRecord[] | undefined, extra: Partial<LLMCallRecord> = {}) {
    const breaker = this.breaker(p);
    const started = Date.now();
    try {
      const result = await invoke(p);
      breaker.recordSuccess();
      trace?.push({ purpose: req.purpose, provider: p.name, model: result.model, ok: true, latencyMs: result.latencyMs, ...extra });
      return result;
    } catch (err) {
      if (err instanceof ProviderError && err.countsAgainstHealth) {
        breaker.recordFailure(err.message, err.kind === "rate_limit" ? err.retryAfterMs : undefined);
      } else {
        breaker.releaseTrial();
      }
      if (!isAbortError(err)) {
        trace?.push({ purpose: req.purpose, provider: p.name, ok: false, latencyMs: Date.now() - started, error: errorMessage(err).slice(0, 300), ...extra });
      }
      throw err;
    }
  }

  private async run(
    req: CompletionRequest,
    trace: LLMCallRecord[] | undefined,
    invoke: (p: LLMProvider) => Promise<CompletionResult>,
    canFallback: () => boolean,
    forceFallbackReason?: string,
  ): Promise<CompletionResult> {
    const estimated = req.messages.reduce((n, m) => n + estimateTokens(m.content), 0) + (req.maxTokens ?? 2048);
    let reason: string | undefined = forceFallbackReason;

    if (reason) {
      // caller already decided the primary's output is unusable
    } else if (estimated > this.primary.contextTokens * 0.9) reason = `context_overflow (~${estimated} tokens)`;
    else if (!this.breaker(this.primary).canRequest()) reason = "circuit_open";

    if (!reason) {
      try {
        return await this.attempt(this.primary, req, invoke, trace);
      } catch (err) {
        if (isAbortError(err) || req.signal?.aborted) throw err;
        if (!canFallback()) throw err;
        reason = err instanceof ProviderError ? err.kind : "error";
        logger.warn({ purpose: req.purpose, reason, err: errorMessage(err).slice(0, 200) }, `LLM primary failed, falling back to ${this.fallback.name}`);
      }
    }

    if (!this.breaker(this.fallback).canRequest()) {
      throw new LLMUnavailableError(`${this.primary.name} unavailable (${reason}) and ${this.fallback.name} circuit is open`);
    }
    const result = await this.attempt(this.fallback, req, invoke, trace, { fallbackFrom: this.primary.name, fallbackReason: reason });
    return { ...result, fallbackFrom: this.primary.name, fallbackReason: reason };
  }
}

export const llm = new LLMRouter(new GroqProvider(), new GeminiProvider());

/** Parses model JSON output, tolerating markdown fences and leading prose. */
export function parseJsonLoose<T = unknown>(text: string): T {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.search(/[[{]/);
    const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1)) as T;
    throw new ProviderError("llm", "bad_request", "model did not return valid JSON");
  }
}
