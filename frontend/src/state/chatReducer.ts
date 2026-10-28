import type { AgentStep, SourceRef } from "../lib/types";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  steps: AgentStep[];
  sources: SourceRef[];
  status: "streaming" | "done" | "error" | "cancelled";
  error?: string;
  meta?: { queryId?: string; provider?: string; model?: string; fallback?: string; timings?: Record<string, number> };
  createdAt: number;
}

/** Conversations keyed by repository id. */
export type ChatState = Record<string, ChatMessage[]>;

export type ChatAction =
  | { type: "user"; repoId: string; id: string; content: string }
  | { type: "assistant_start"; repoId: string; id: string }
  | { type: "step"; repoId: string; id: string; step: AgentStep }
  | { type: "sources"; repoId: string; id: string; sources: SourceRef[] }
  | { type: "token"; repoId: string; id: string; text: string }
  | { type: "done"; repoId: string; id: string; answer: string; meta: ChatMessage["meta"] }
  | { type: "error"; repoId: string; id: string; error: string }
  | { type: "cancel"; repoId: string; id: string }
  | { type: "clear"; repoId: string };

function update(state: ChatState, repoId: string, id: string, fn: (m: ChatMessage) => ChatMessage): ChatState {
  const list = state[repoId] ?? [];
  return { ...state, [repoId]: list.map((m) => (m.id === id ? fn(m) : m)) };
}

export function chatReducer(state: ChatState, a: ChatAction): ChatState {
  switch (a.type) {
    case "user":
      return { ...state, [a.repoId]: [...(state[a.repoId] ?? []), { id: a.id, role: "user", content: a.content, steps: [], sources: [], status: "done", createdAt: Date.now() }] };
    case "assistant_start":
      return {
        ...state,
        [a.repoId]: [...(state[a.repoId] ?? []), { id: a.id, role: "assistant", content: "", steps: [], sources: [], status: "streaming", createdAt: Date.now() }],
      };
    case "step":
      return update(state, a.repoId, a.id, (m) => {
        const i = m.steps.findIndex((s) => s.id === a.step.id);
        const steps = i >= 0 ? m.steps.map((s, j) => (j === i ? a.step : s)) : [...m.steps, a.step];
        return { ...m, steps };
      });
    case "sources":
      return update(state, a.repoId, a.id, (m) => ({ ...m, sources: a.sources }));
    case "token":
      return update(state, a.repoId, a.id, (m) => ({ ...m, content: m.content + a.text }));
    case "done":
      return update(state, a.repoId, a.id, (m) => ({ ...m, content: a.answer || m.content, status: "done", meta: a.meta }));
    case "error":
      return update(state, a.repoId, a.id, (m) => ({ ...m, status: "error", error: a.error }));
    case "cancel":
      return update(state, a.repoId, a.id, (m) => (m.status === "streaming" ? { ...m, status: "cancelled" } : m));
    case "clear":
      return { ...state, [a.repoId]: [] };
  }
}
