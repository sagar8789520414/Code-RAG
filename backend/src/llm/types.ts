export type Tier = "reasoning" | "fast";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  /** Short label for traces: "plan", "rerank", "synthesize", ... */
  purpose: string;
  tier: Tier;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  provider: string;
  model: string;
  latencyMs: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  fallbackFrom?: string;
  fallbackReason?: string;
}

export interface LLMProvider {
  readonly name: string;
  readonly contextTokens: number;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  /** Streams text deltas through `onDelta`; resolves with the full text. */
  stream(req: CompletionRequest, onDelta: (text: string) => void): Promise<CompletionResult>;
}

export interface LLMCallRecord {
  purpose: string;
  provider: string;
  model?: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
  fallbackFrom?: string;
  fallbackReason?: string;
}
