import { env } from "../config/env.js";
import { ProviderError } from "../lib/errors.js";
import { providerFetch, readSseData } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import type { CompletionRequest, CompletionResult, LLMProvider } from "./types.js";

interface GeminiPart {
  text?: string;
  thought?: boolean;
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
}

/** Errors where trying the next model in the chain may succeed. */
const isModelLevelFailure = (err: unknown) =>
  err instanceof ProviderError && (err.kind === "server_error" || err.kind === "rate_limit" || err.kind === "timeout" || err.status === 404);

/**
 * Google Gemini generateContent API. Walks a configured model chain (e.g. flash → flash-lite)
 * because individual models are regularly overloaded (503) while siblings still serve.
 */
export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  readonly contextTokens = env.GEMINI_CONTEXT_TOKENS;

  private models(req: CompletionRequest): string[] {
    return req.tier === "fast" ? env.GEMINI_FAST_MODELS : env.GEMINI_MODELS;
  }

  private body(req: CompletionRequest, model: string, withThinking: boolean): Record<string, unknown> {
    const system = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const contents = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    const generationConfig: Record<string, unknown> = {
      temperature: req.temperature ?? 0.2,
      maxOutputTokens: req.maxTokens ? req.maxTokens * 2 : req.tier === "fast" ? 4096 : 8192,
    };
    if (req.json) generationConfig.responseMimeType = "application/json";
    if (withThinking) {
      generationConfig.thinkingConfig = /gemini-2\.5/.test(model)
        ? { thinkingBudget: req.tier === "fast" ? 0 : 1024 }
        : { thinkingLevel: req.tier === "fast" ? "minimal" : "low" };
    }
    return {
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents,
      generationConfig,
    };
  }

  private async post(req: CompletionRequest, model: string, stream: boolean): Promise<Response> {
    const url = `${env.GEMINI_BASE_URL}/models/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    const send = (withThinking: boolean) =>
      providerFetch(this.name, url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify(this.body(req, model, withThinking)),
        timeoutMs: stream ? env.GEMINI_TIMEOUT_MS * 3 : env.GEMINI_TIMEOUT_MS,
        ...(stream ? { headersTimeoutMs: 20_000 } : {}),
        callerSignal: req.signal,
      });
    try {
      return await send(true);
    } catch (err) {
      // Older/newer models reject thinking settings they don't support; retry without them.
      if (err instanceof ProviderError && err.kind === "bad_request" && /thinking/i.test(err.message)) return send(false);
      throw err;
    }
  }

  private async withModelChain(req: CompletionRequest, fn: (model: string) => Promise<CompletionResult>): Promise<CompletionResult> {
    let lastErr: unknown;
    for (const model of this.models(req)) {
      try {
        return await fn(model);
      } catch (err) {
        lastErr = err;
        if (!isModelLevelFailure(err)) throw err;
        logger.warn({ model, err: (err as Error).message.slice(0, 160) }, "gemini model failed, trying next in chain");
      }
    }
    throw lastErr;
  }

  private extractText(json: GeminiResponse): string {
    if (json.promptFeedback?.blockReason) throw new ProviderError(this.name, "bad_request", `prompt blocked: ${json.promptFeedback.blockReason}`);
    const cand = json.candidates?.[0];
    return (cand?.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? "")
      .join("");
  }

  complete(req: CompletionRequest): Promise<CompletionResult> {
    return this.withModelChain(req, async (model) => {
      const started = Date.now();
      const res = await this.post(req, model, false);
      const json = (await res.json()) as GeminiResponse;
      const text = this.extractText(json);
      if (!text.trim()) {
        const reason = json.candidates?.[0]?.finishReason;
        throw new ProviderError(this.name, reason === "MAX_TOKENS" ? "context_overflow" : "server_error", `empty completion (finishReason=${reason ?? "none"})`);
      }
      return {
        text,
        provider: this.name,
        model: json.modelVersion ?? model,
        latencyMs: Date.now() - started,
        usage: { inputTokens: json.usageMetadata?.promptTokenCount, outputTokens: json.usageMetadata?.candidatesTokenCount },
      };
    });
  }

  stream(req: CompletionRequest, onDelta: (text: string) => void): Promise<CompletionResult> {
    return this.withModelChain(req, async (model) => {
      const started = Date.now();
      const res = await this.post(req, model, true);
      let text = "";
      let usage: CompletionResult["usage"];
      let version = model;
      for await (const data of readSseData(res, { provider: this.name, signal: req.signal })) {
        let evt: GeminiResponse;
        try {
          evt = JSON.parse(data) as GeminiResponse;
        } catch {
          continue;
        }
        const delta = this.extractText(evt);
        if (delta) {
          text += delta;
          onDelta(delta);
        }
        if (evt.usageMetadata) usage = { inputTokens: evt.usageMetadata.promptTokenCount, outputTokens: evt.usageMetadata.candidatesTokenCount };
        if (evt.modelVersion) version = evt.modelVersion;
      }
      if (!text.trim()) throw new ProviderError(this.name, "server_error", "empty streamed completion");
      return { text, provider: this.name, model: version, latencyMs: Date.now() - started, usage };
    });
  }
}
