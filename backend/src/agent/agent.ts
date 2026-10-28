import crypto from "node:crypto";
import { z } from "zod";
import { env } from "../config/env.js";
import { collections } from "../db/mongo.js";
import type { QueryDoc, SourceRef } from "../db/models.js";
import { NotFoundError, errorMessage, isAbortError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { llm, LLMUnavailableError } from "../llm/router.js";
import type { ChatMessage, LLMCallRecord } from "../llm/types.js";
import { findSymbols, hybridSearch, type ChunkHit } from "../search/hybrid.js";
import { calledSymbols } from "./graph.js";
import { ANSWER_SYSTEM, EVALUATOR_SYSTEM, PLANNER_SYSTEM, contextBlock, evidenceDigest } from "./prompts.js";

export type StepKind = "plan" | "retrieve" | "expand" | "evaluate" | "synthesize";

export interface AgentStep {
  id: string;
  kind: StepKind;
  status: "running" | "done" | "error" | "skipped";
  title: string;
  detail?: string;
  data?: unknown;
  startedAt: number;
  durationMs?: number;
}

export type AgentEvent =
  | { type: "step"; step: AgentStep }
  | { type: "sources"; sources: SourceRef[] }
  | { type: "token"; text: string }
  | { type: "done"; queryId: string; answer: string; provider?: string; model?: string; fallback?: string; timings: Record<string, number> }
  | { type: "error"; message: string; queryId?: string };

export interface AgentInput {
  repoId: string;
  question: string;
  history?: ChatMessage[];
  rerank?: boolean;
  maxHops?: number;
}

const planSchema = z.object({
  intent: z.enum(["lookup", "multi_hop", "smalltalk"]).catch("lookup"),
  standalone_question: z.string().min(1),
  sub_queries: z
    .array(z.object({ query: z.string().min(2), purpose: z.string().optional().default("") }))
    .min(1)
    .transform((a) => a.slice(0, 4)),
});
type Plan = z.infer<typeof planSchema>;

const evalSchema = z.object({
  sufficient: z.boolean(),
  missing: z.string().optional().default(""),
  follow_up_queries: z
    .array(z.string().min(2))
    .optional()
    .default([])
    .transform((a) => a.slice(0, 3)),
});

interface Evidence {
  chunk: ChunkHit;
  /** Higher is better; best position across all searches that returned it. */
  score: number;
  via: Set<string>;
  hop: number;
}

const PER_QUERY_K = 6;

export class AgentRun {
  readonly id = crypto.randomUUID();
  private readonly steps: AgentStep[] = [];
  private readonly llmCalls: LLMCallRecord[] = [];
  private readonly evidence = new Map<string, Evidence>();
  private readonly timings: Record<string, number> = {};
  private readonly started = Date.now();

  constructor(
    private readonly input: AgentInput,
    private readonly emit: (e: AgentEvent) => void,
    private readonly signal: AbortSignal,
  ) {}

  private step(kind: StepKind, title: string): AgentStep {
    const s: AgentStep = { id: `${kind}-${this.steps.length + 1}`, kind, status: "running", title, startedAt: Date.now() };
    this.steps.push(s);
    this.emit({ type: "step", step: { ...s } });
    return s;
  }

  private finish(s: AgentStep, status: AgentStep["status"], detail?: string, data?: unknown): void {
    s.status = status;
    s.durationMs = Date.now() - s.startedAt;
    if (detail !== undefined) s.detail = detail;
    if (data !== undefined) s.data = data;
    this.emit({ type: "step", step: { ...s } });
  }

  private addEvidence(hits: ChunkHit[], via: string, hop: number, weight = 1): number {
    let added = 0;
    hits.forEach((chunk, i) => {
      const score = weight / (i + 1);
      const existing = this.evidence.get(chunk.id);
      if (existing) {
        existing.score = Math.max(existing.score, score) + 0.05; // corroborated by another search
        existing.via.add(via);
      } else {
        this.evidence.set(chunk.id, { chunk, score, via: new Set([via]), hop });
        added++;
      }
    });
    return added;
  }

  private async plan(repoName: string, filePaths: string[]): Promise<Plan> {
    const s = this.step("plan", "Decomposing the question");
    const history = (this.input.history ?? []).slice(-6).map((m) => `${m.role}: ${m.content.slice(0, 600)}`).join("\n");
    try {
      const { value } = await llm.completeJson(
        {
          purpose: "plan",
          tier: "fast",
          temperature: 0,
          maxTokens: 1200,
          signal: this.signal,
          messages: [
            { role: "system", content: PLANNER_SYSTEM },
            {
              role: "user",
              content: `Repository: ${repoName}\nSample of files:\n${filePaths.join("\n")}\n\n${history ? `Conversation so far:\n${history}\n\n` : ""}Question: ${this.input.question}`,
            },
          ],
        },
        (v) => planSchema.parse(v),
        this.llmCalls,
      );
      this.finish(
        s,
        "done",
        value.intent === "smalltalk" ? "No code search needed" : `${value.sub_queries.length} sub-quer${value.sub_queries.length === 1 ? "y" : "ies"} (${value.intent})`,
        value,
      );
      return value;
    } catch (err) {
      if (isAbortError(err)) throw err;
      const fallback: Plan = { intent: "lookup", standalone_question: this.input.question, sub_queries: [{ query: this.input.question, purpose: "original question" }] };
      this.finish(s, "error", `Planner unavailable, searching with the original question (${errorMessage(err).slice(0, 120)})`, fallback);
      return fallback;
    }
  }

  private async retrieve(queries: string[], hop: number): Promise<void> {
    await Promise.all(
      queries.map(async (q) => {
        const s = this.step("retrieve", `Hybrid search: “${q}”`);
        try {
          const res = await hybridSearch({
            repoId: this.input.repoId,
            query: q,
            k: PER_QUERY_K,
            rerank: this.input.rerank ?? true,
            signal: this.signal,
            trace: this.llmCalls,
          });
          const added = this.addEvidence(
            res.results.map((r) => r.chunk),
            `search:${q}`,
            hop,
          );
          this.finish(s, "done", `${res.results.length} hits (${added} new)${res.reranked ? ", reranked" : ""} in ${res.timings.totalMs}ms`, {
            query: q,
            reranked: res.reranked,
            hits: res.results.map((r) => ({
              path: r.chunk.path,
              symbol: r.chunk.symbolPath,
              lines: [r.chunk.startLine, r.chunk.endLine],
              bm25Rank: r.bm25Rank,
              vectorRank: r.vectorRank,
              rerankScore: r.rerankScore,
            })),
          });
        } catch (err) {
          if (isAbortError(err)) throw err;
          this.finish(s, "error", errorMessage(err).slice(0, 200));
        }
      }),
    );
  }

  private async expandCallGraph(hop: number): Promise<void> {
    const top = this.ranked().slice(0, 8).map((e) => e.chunk);
    const names = calledSymbols(top, 10);
    if (!names.length) return;
    const s = this.step("expand", "Following call graph");
    try {
      const defs = (await findSymbols(this.input.repoId, names, 12)).filter((d) => !this.evidence.has(d.id));
      this.addEvidence(defs.slice(0, 6), "call-graph", hop, 0.35);
      this.finish(s, "done", defs.length ? `Resolved ${defs.slice(0, 6).map((d) => d.symbolPath).join(", ")}` : `No definitions found for ${names.slice(0, 5).join(", ")}`, {
        calls: names,
        resolved: defs.slice(0, 6).map((d) => ({ path: d.path, symbol: d.symbolPath })),
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      this.finish(s, "error", errorMessage(err).slice(0, 200));
    }
  }

  private async evaluate(question: string): Promise<string[]> {
    const s = this.step("evaluate", "Checking evidence coverage");
    try {
      const { value } = await llm.completeJson(
        {
          purpose: "evaluate",
          tier: "fast",
          temperature: 0,
          maxTokens: 800,
          signal: this.signal,
          messages: [
            { role: "system", content: EVALUATOR_SYSTEM },
            { role: "user", content: `Question: ${question}\n\nEvidence:\n${evidenceDigest(this.ranked().slice(0, 16).map((e) => e.chunk))}` },
          ],
        },
        (v) => evalSchema.parse(v),
        this.llmCalls,
      );
      const followUps = value.sufficient ? [] : value.follow_up_queries;
      this.finish(s, "done", value.sufficient ? "Evidence covers the question" : `Missing: ${value.missing || "more context"}`, value);
      return followUps;
    } catch (err) {
      if (isAbortError(err)) throw err;
      this.finish(s, "error", `Evaluator unavailable (${errorMessage(err).slice(0, 120)}); continuing`);
      return [];
    }
  }

  private ranked(): Evidence[] {
    return [...this.evidence.values()].sort((a, b) => b.score - a.score || a.hop - b.hop);
  }

  /** Top evidence, guaranteeing each search contributes its best hits (diversity across sub-queries). */
  private selectContext(): Evidence[] {
    const limit = env.AGENT_CONTEXT_CHUNKS;
    const ranked = this.ranked();
    const chosen = new Map<string, Evidence>();
    const bySource = new Map<string, Evidence[]>();
    for (const e of ranked) for (const v of e.via) bySource.set(v, [...(bySource.get(v) ?? []), e]);
    for (const list of bySource.values()) for (const e of list.slice(0, 2)) if (chosen.size < limit) chosen.set(e.chunk.id, e);
    for (const e of ranked) if (chosen.size < limit) chosen.set(e.chunk.id, e);
    // File-outline chunks are useful for search but weak as answer context; put real code first.
    return [...chosen.values()].sort((a, b) => Number(a.chunk.kind === "file") - Number(b.chunk.kind === "file") || b.score - a.score);
  }

  async run(): Promise<QueryDoc> {
    const { repos, files, queries } = collections();
    const repo = await repos.findOne({ _id: this.input.repoId });
    if (!repo) throw new NotFoundError("Repository");

    let answer = "";
    let status: QueryDoc["status"] = "completed";
    let error: string | undefined;
    let plan: Plan | undefined;
    let sources: SourceRef[] = [];
    let final: { provider?: string; model?: string; fallback?: string } = {};

    try {
      const sample = await files
        .find({ repoId: repo._id }, { projection: { path: 1 } })
        .sort({ path: 1 })
        .limit(200)
        .map((f) => f.path)
        .toArray();
      const tPlan = Date.now();
      plan = await this.plan(repo.name, sample);
      this.timings.planMs = Date.now() - tPlan;

      if (plan.intent !== "smalltalk") {
        const tRetrieve = Date.now();
        await this.retrieve(
          plan.sub_queries.map((q) => q.query),
          0,
        );
        await this.expandCallGraph(0);
        const maxHops = this.input.maxHops ?? env.AGENT_MAX_HOPS;
        const asked = new Set(plan.sub_queries.map((q) => q.query.toLowerCase()));
        for (let hop = 1; hop <= maxHops && this.evidence.size > 0; hop++) {
          const followUps = (await this.evaluate(plan.standalone_question)).filter((q) => !asked.has(q.toLowerCase()));
          if (!followUps.length) break;
          followUps.forEach((q) => asked.add(q.toLowerCase()));
          await this.retrieve(followUps, hop);
        }
        this.timings.retrieveMs = Date.now() - tRetrieve;
      }

      const context = this.selectContext();
      sources = context.map((e, i) => ({
        n: i + 1,
        chunkId: e.chunk.id,
        path: e.chunk.path,
        name: e.chunk.name,
        symbolPath: e.chunk.symbolPath,
        kind: e.chunk.kind,
        language: e.chunk.language,
        startLine: e.chunk.startLine,
        endLine: e.chunk.endLine,
        score: Number(e.score.toFixed(4)),
        via: [...e.via],
      }));
      this.emit({ type: "sources", sources });

      const s = this.step("synthesize", "Writing the answer");
      const tAnswer = Date.now();
      const subParts = plan.sub_queries.length > 1 ? `\n\nMake sure to cover: ${plan.sub_queries.map((q) => q.purpose || q.query).join("; ")}.` : "";
      const messages: ChatMessage[] = [
        { role: "system", content: ANSWER_SYSTEM },
        ...(this.input.history ?? []).slice(-6).map((m) => ({ role: m.role, content: m.content.slice(0, 2000) })),
        {
          role: "user",
          content:
            plan.intent === "smalltalk" || !context.length
              ? `${context.length ? "" : "(No relevant code was retrieved from the repository.)\n\n"}${this.input.question}`
              : `Repository: ${repo.name}\n\nContext chunks:\n\n${contextBlock(context.map((e) => e.chunk))}\n\nQuestion: ${plan.standalone_question}${subParts}`,
        },
      ];
      const result = await llm.stream(
        { purpose: "synthesize", tier: "reasoning", temperature: 0.2, maxTokens: 4096, signal: this.signal, messages },
        (t) => {
          answer += t;
          this.emit({ type: "token", text: t });
        },
        this.llmCalls,
      );
      answer = result.text;
      final = { provider: result.provider, model: result.model, ...(result.fallbackReason ? { fallback: `${result.fallbackFrom}→${result.provider}: ${result.fallbackReason}` } : {}) };
      this.timings.answerMs = Date.now() - tAnswer;
      this.finish(s, "done", `${result.provider} · ${result.model}${result.fallbackReason ? ` (fallback: ${result.fallbackReason})` : ""}`);
    } catch (err) {
      if (isAbortError(err) || this.signal.aborted) {
        status = "cancelled";
        error = "cancelled by client";
      } else {
        status = "failed";
        error = err instanceof LLMUnavailableError ? `All LLM providers are unavailable right now: ${err.message}` : errorMessage(err);
        logger.error({ err: error, queryId: this.id }, "agent run failed");
        for (const s of this.steps) if (s.status === "running") this.finish(s, "error", "aborted");
        this.emit({ type: "error", message: error, queryId: this.id });
      }
    }

    this.timings.totalMs = Date.now() - this.started;
    const doc: QueryDoc = {
      _id: this.id,
      repoId: repo._id,
      question: this.input.question,
      ...(plan ? { plan } : {}),
      steps: this.steps,
      sources,
      answer,
      llmCalls: this.llmCalls,
      timings: this.timings,
      status,
      ...(error ? { error } : {}),
      createdAt: new Date(this.started),
    };
    await queries.insertOne(doc).catch((e) => logger.error({ err: errorMessage(e) }, "failed to persist query"));
    if (status === "completed") this.emit({ type: "done", queryId: this.id, answer, ...final, timings: this.timings });
    return doc;
  }
}
