import { describe, expect, it } from "vitest";
import { calledSymbols } from "../src/agent/graph.js";
import { matchesExpected, scoreRanking, summarize } from "../src/benchmark/metrics.js";
import { parseNameStatus, parseUnifiedDiff } from "../src/ingestion/git.js";
import { CircuitBreaker } from "../src/lib/circuitBreaker.js";
import { classifyHttpFailure, parseRetryAfter } from "../src/lib/http.js";
import { identifierTokens, splitIdentifier } from "../src/lib/text.js";
import { parseJsonLoose } from "../src/llm/router.js";
import { buildTextQuery, extractTerms, filterClause } from "../src/search/queryBuilder.js";
import { escapeTag } from "../src/search/redisIndex.js";
import { reciprocalRankFusion } from "../src/search/rrf.js";
import type { ChunkHit } from "../src/search/hybrid.js";

describe("reciprocalRankFusion", () => {
  it("implements Σ 1/(k + rank) with 1-based ranks", () => {
    const fused = reciprocalRankFusion(
      [
        { name: "bm25", ids: ["a", "b", "c"] },
        { name: "vector", ids: ["c", "a", "d"] },
      ],
      60,
    );
    const score = Object.fromEntries(fused.map((f) => [f.id, f.score]));
    expect(score.a).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(score.c).toBeCloseTo(1 / 63 + 1 / 61, 12);
    expect(score.b).toBeCloseTo(1 / 62, 12);
    expect(fused.map((f) => f.id)).toEqual(["a", "c", "b", "d"]);
    expect(fused[0]!.ranks).toEqual({ bm25: 1, vector: 2 });
  });

  it("rewards agreement between retrievers over a single top hit", () => {
    const fused = reciprocalRankFusion([
      { name: "bm25", ids: ["solo", "both"] },
      { name: "vector", ids: ["x", "both"] },
    ]);
    expect(fused[0]!.id).toBe("both");
  });

  it("honours weights and ignores duplicate ids within a list", () => {
    const fused = reciprocalRankFusion(
      [
        { name: "bm25", ids: ["a", "a", "b"], weight: 1 },
        { name: "vector", ids: ["b"], weight: 3 },
      ],
      60,
    );
    expect(fused[0]!.id).toBe("b");
    expect(fused.find((f) => f.id === "a")!.score).toBeCloseTo(1 / 61, 12);
  });
});

describe("BM25 query builder", () => {
  it("drops filler words and splits identifiers", () => {
    expect(extractTerms("Where is authentication handled and how does validateSessionToken work?")).toEqual([
      "authentication",
      "validatesessiontoken",
      "validate",
      "session",
      "token",
    ]);
    expect(extractTerms("get_user_by_id")).toEqual(["get_user_by_id", "user", "id"]);
  });

  it("builds a repo-scoped OR query and escapes tag values", () => {
    expect(buildTextQuery("abc123", "jwt middleware")).toBe("@repo:{abc123} (jwt|middleware)");
    expect(buildTextQuery("abc123", "how does it work?")).toBeUndefined();
    expect(filterClause("r1", { language: "typescript", pathPrefix: "src/auth", kinds: ["function", "method"] })).toBe(
      "@repo:{r1} @language:{typescript} @kind:{function|method} @pathTag:{src\\/auth*}",
    );
    expect(escapeTag("a-b.c d")).toBe("a\\-b\\.c\\ d");
  });
});

describe("text utils", () => {
  it("splits camel, pascal, snake and acronyms", () => {
    expect(splitIdentifier("parseHTTPResponse_v2")).toEqual(["parse", "http", "response", "v2"]);
    expect(identifierTokens("const userId = getUserById(req.params.userId)")).toBe("const user id get by req params");
  });
});

describe("CircuitBreaker", () => {
  it("opens after the threshold, half-opens after cooldown, and closes on success", () => {
    let now = 0;
    const b = new CircuitBreaker("groq", { failureThreshold: 3, cooldownMs: 1000, now: () => now });
    for (let i = 0; i < 3; i++) {
      expect(b.canRequest()).toBe(true);
      b.recordFailure("500");
    }
    expect(b.canRequest()).toBe(false);
    now = 1001;
    expect(b.canRequest()).toBe(true); // trial
    expect(b.canRequest()).toBe(false); // only one trial at a time
    b.recordSuccess();
    expect(b.snapshot().state).toBe("closed");
    expect(b.canRequest()).toBe(true);
  });

  it("opens immediately for rate limits and honours retry-after", () => {
    let now = 0;
    const b = new CircuitBreaker("groq", { failureThreshold: 3, cooldownMs: 1000, now: () => now });
    b.recordFailure("429", 5000);
    now = 2000;
    expect(b.canRequest()).toBe(false);
    now = 5001;
    expect(b.canRequest()).toBe(true);
    b.recordFailure("still failing");
    expect(b.snapshot().state).toBe("open"); // a failed trial re-opens
  });
});

describe("provider failure classification", () => {
  it("maps HTTP status and bodies to failure kinds", () => {
    expect(classifyHttpFailure(429, "")).toBe("rate_limit");
    expect(classifyHttpFailure(503, "overloaded")).toBe("server_error");
    expect(classifyHttpFailure(400, '{"error":{"code":"context_length_exceeded"}}')).toBe("context_overflow");
    expect(classifyHttpFailure(413, "")).toBe("context_overflow");
    expect(classifyHttpFailure(401, "")).toBe("auth");
    expect(classifyHttpFailure(400, "bad")).toBe("bad_request");
  });

  it("parses retry hints", () => {
    expect(parseRetryAfter(new Headers({ "retry-after": "7" }))).toBe(7000);
    expect(parseRetryAfter(new Headers(), '{"retryDelay": "12s"}')).toBe(12000);
  });

  it("parses loose JSON from models", () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('Sure! {"a":[1,2]} hope that helps')).toEqual({ a: [1, 2] });
  });
});

describe("git diff parsing", () => {
  it("parses -z name-status including renames", () => {
    const out = ["M", "src/a.ts", "A", "src/b.ts", "D", "old.py", "R087", "src/x.ts", "src/y.ts", ""].join("\0");
    expect(parseNameStatus(out)).toEqual([
      { status: "modified", path: "src/a.ts" },
      { status: "added", path: "src/b.ts" },
      { status: "deleted", path: "old.py" },
      { status: "renamed", path: "src/y.ts", oldPath: "src/x.ts" },
    ]);
  });

  it("parses -U0 hunks per file", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,2 +10,3 @@ function foo() {",
      "-x",
      "+y",
      "@@ -40 +41,0 @@",
      "-gone",
      "diff --git a/old.py b/old.py",
      "deleted file mode 100644",
      "--- a/old.py",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
    ].join("\n");
    const hunks = parseUnifiedDiff(diff);
    expect(hunks.get("src/a.ts")).toEqual([
      { oldStart: 10, oldLines: 2, newStart: 10, newLines: 3 },
      { oldStart: 40, oldLines: 1, newStart: 41, newLines: 0 },
    ]);
    expect(hunks.get("old.py")).toEqual([{ oldStart: 1, oldLines: 3, newStart: 0, newLines: 0 }]);
  });
});

describe("benchmark metrics", () => {
  const hit = (path: string, symbolPath: string, startLine: number, endLine: number, kind = "method") => ({
    path,
    kind,
    name: symbolPath.split(".").pop()!,
    symbolPath,
    startLine,
    endLine,
  });

  it("matches by symbol, enclosing scope, or line overlap", () => {
    expect(matchesExpected(hit("src/s.py", "Session.request", 10, 40), { path: "src/s.py", symbol: "Session.request" })).toBe(true);
    expect(matchesExpected(hit("src/s.py", "Session", 1, 80, "class"), { path: "src/s.py", symbol: "Session.request" })).toBe(true);
    expect(matchesExpected(hit("src/s.py", "Session.send", 50, 70), { path: "src/s.py", symbol: "Session.request" })).toBe(false);
    expect(matchesExpected(hit("src/s.py", "src/s.py#L1", 5, 30, "block"), { path: "src/s.py", symbol: "Session.request", resolvedLines: [10, 40] })).toBe(true);
    expect(matchesExpected(hit("src/s.py", "s.py", 1, 900, "file"), { path: "src/s.py", symbol: "Session.request", resolvedLines: [10, 40] })).toBe(false);
    expect(matchesExpected(hit("src/s.py", "s.py", 1, 900, "file"), { path: "src/s.py" })).toBe(true);
  });

  it("computes hit@k, MRR and recall", () => {
    const expected = [{ path: "a.ts", symbol: "f" }];
    const s1 = scoreRanking([hit("b.ts", "g", 1, 2), hit("a.ts", "f", 1, 5)], expected, 10);
    const s2 = scoreRanking([hit("b.ts", "g", 1, 2)], expected, 10);
    expect(s1.firstHitRank).toBe(2);
    const sum = summarize([
      { ...s1, latencyMs: 100 },
      { ...s2, latencyMs: 300 },
    ]);
    expect(sum["hit@1"]).toBe(0);
    expect(sum["hit@3"]).toBe(0.5);
    expect(sum.mrr).toBe(0.25);
    expect(sum["recall@k"]).toBe(0.5);
    expect(sum.avgLatencyMs).toBe(200);
  });
});

describe("call-graph expansion", () => {
  it("collects called-but-undefined repo symbols", () => {
    const chunk = (name: string, content: string): ChunkHit => ({
      id: name,
      repoId: "r",
      path: "a.ts",
      language: "typescript",
      kind: "function",
      name,
      symbolPath: name,
      parentScope: "",
      signature: "",
      docstring: "",
      content,
      startLine: 1,
      endLine: 2,
    });
    const names = calledSymbols([
      chunk("authMiddleware", "function authMiddleware(req) { const s = verifySession(token); if (s) next(); logAudit(s); console.log(x) }"),
      chunk("login", "function login() { return verifySession(issueToken()) }"),
    ]);
    expect(names).toEqual(["verifySession", "issueToken", "logAudit"]);
  });
});
