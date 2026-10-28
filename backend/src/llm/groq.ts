import { env } from "../config/env.js";
import { ProviderError } from "../lib/errors.js";
import { providerFetch, readSseData } from "../lib/http.js";
import type { CompletionRequest, CompletionResult, LLMProvider } from "./types.js";

interface GroqChoice {
  message?: { content?: string | null };
  delta?: { content?: string | null };
  finish_reason?: string | null;
}

interface GroqResponse {
  choices?: GroqChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  x_groq?: { usage?: { prompt_tokens?: number; completion_tokens?: number } };
  error?: { message?: string; code?: string };
}

/** Groq's OpenAI-compatible chat completions API. */
export class GroqProvider implements LLMProvider {
  readonly name = "groq";
  readonly contextTokens = env.GROQ_CONTEXT_TOKENS;

  private model(req: CompletionRequest): string {
    return req.tier === "fast" ? env.GROQ_FAST_MODEL : env.GROQ_MODEL;
  }

  private body(req: CompletionRequest, stream: boolean): Record<string, unknown> {
    const model = this.model(req);
    const body: Record<string, unknown> = {
      model,
      messages: req.messages,
      temperature: req.temperature ?? 0.2,
      max_completion_tokens: req.maxTokens ?? (req.tier === "fast" ? 2048 : 4096),
      stream,
    };
    if (req.json) body.response_format = { type: "json_object" };
    if (model.startsWith("openai/gpt-oss")) {
      // Reasoning tokens count toward max_completion_tokens; keep them proportionate.
      body.reasoning_effort = req.tier === "fast" ? "low" : "medium";
      body.include_reasoning = false;
    }
    if (stream) body.stream_options = { include_usage: true };
    return body;
  }

  private async post(req: CompletionRequest, stream: boolean): Promise<Response> {
    return providerFetch(this.name, `${env.GROQ_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: JSON.stringify(this.body(req, stream)),
      timeoutMs: stream ? env.GROQ_TIMEOUT_MS * 3 : env.GROQ_TIMEOUT_MS,
      ...(stream ? { headersTimeoutMs: 20_000 } : {}),
      callerSignal: req.signal,
    });
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const res = await this.post(req, false);
    const json = (await res.json()) as GroqResponse;
    const choice = json.choices?.[0];
    const text = choice?.message?.content ?? "";
    if (!text.trim()) {
      const reason = choice?.finish_reason === "length" ? "context_overflow" : "server_error";
      throw new ProviderError(this.name, reason, `empty completion (finish_reason=${choice?.finish_reason ?? "none"})`);
    }
    return {
      text,
      provider: this.name,
      model: this.model(req),
      latencyMs: Date.now() - started,
      usage: { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens },
    };
  }

  async stream(req: CompletionRequest, onDelta: (text: string) => void): Promise<CompletionResult> {
    const started = Date.now();
    const res = await this.post(req, true);
    let text = "";
    let usage: CompletionResult["usage"];
    for await (const data of readSseData(res, { provider: this.name, signal: req.signal })) {
      if (data === "[DONE]") break;
      let evt: GroqResponse;
      try {
        evt = JSON.parse(data) as GroqResponse;
      } catch {
        continue;
      }
      if (evt.error) throw new ProviderError(this.name, "server_error", evt.error.message ?? "stream error");
      const delta = evt.choices?.[0]?.delta?.content;
      if (delta) {
        text += delta;
        onDelta(delta);
      }
      const u = evt.x_groq?.usage ?? evt.usage;
      if (u) usage = { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens };
    }
    if (!text.trim()) throw new ProviderError(this.name, "server_error", "empty streamed completion");
    return { text, provider: this.name, model: this.model(req), latencyMs: Date.now() - started, usage };
  }
}
