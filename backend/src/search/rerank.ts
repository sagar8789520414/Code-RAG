import { z } from "zod";
import { llm } from "../llm/router.js";
import type { LLMCallRecord } from "../llm/types.js";
import { truncate } from "../lib/text.js";
import type { ChunkHit } from "./hybrid.js";

const SNIPPET_CHARS = 700;

const scoresSchema = z.object({
  scores: z
    .array(z.object({ id: z.coerce.number().int(), score: z.coerce.number().min(0).max(10) }))
    .min(1),
});

export interface RerankOutcome {
  /** Relevance 0..10 by candidate index; undefined when the judge skipped one. */
  scores: Array<number | undefined>;
  provider: string;
  model: string;
  latencyMs: number;
}

/**
 * Listwise LLM reranker acting as a cross-encoder: the model sees the query and every
 * candidate together and grades each one, which captures query–code interactions that
 * independent BM25/embedding scores cannot.
 */
export async function rerankWithLlm(query: string, hits: ChunkHit[], signal?: AbortSignal, trace?: LLMCallRecord[]): Promise<RerankOutcome> {
  const candidates = hits
    .map((h, i) => {
      const header = `[${i + 1}] ${h.path}:${h.startLine}-${h.endLine} · ${h.kind} ${h.symbolPath}`;
      const doc = h.docstring ? `doc: ${truncate(h.docstring, 200)}\n` : "";
      return `${header}\n${doc}${truncate(h.content, SNIPPET_CHARS)}`;
    })
    .join("\n\n---\n\n");

  const { value, result } = await llm.completeJson(
    {
      purpose: "rerank",
      tier: "fast",
      temperature: 0,
      maxTokens: 1500,
      signal,
      messages: [
        {
          role: "system",
          content:
            "You are a code search relevance judge. Grade how useful each candidate code chunk is for answering the developer's query.\n" +
            "10 = contains the exact definition/implementation asked about; 7-9 = directly relevant logic; 4-6 = related supporting context; 1-3 = tangential; 0 = irrelevant.\n" +
            'Respond with JSON only: {"scores":[{"id":<candidate number>,"score":<0-10>}]} including every candidate.',
        },
        { role: "user", content: `Query: ${query}\n\nCandidates:\n\n${candidates}` },
      ],
    },
    (v) => scoresSchema.parse(v),
    trace,
  );

  const scores: Array<number | undefined> = new Array(hits.length).fill(undefined);
  for (const s of value.scores) if (s.id >= 1 && s.id <= hits.length) scores[s.id - 1] = s.score;
  return { scores, provider: result.provider, model: result.model, latencyMs: result.latencyMs };
}
