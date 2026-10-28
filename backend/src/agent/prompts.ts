import type { ChunkHit } from "../search/hybrid.js";
import { truncate } from "../lib/text.js";

export const PLANNER_SYSTEM = `You plan code-search for a developer-onboarding assistant over one repository.
Given the question (and recent conversation), decide how to search the codebase.

Rules:
- "intent": "smalltalk" for greetings/thanks/meta questions that need no code; "lookup" for a single focused question; "multi_hop" when the question has several parts or needs following a flow across components (e.g. "where is auth handled and how is the token validated in middleware").
- "standalone_question": the question rewritten to be self-contained (resolve pronouns using the conversation).
- "sub_queries": 1-4 focused search queries. Each should target ONE concept and include likely identifiers, file names, or technical terms (e.g. "JWT token verification middleware verifyToken"). For "lookup" usually 1-2; for "multi_hop" one per hop/part.
- Use names from the provided file list when they look relevant.

Respond with JSON only:
{"intent":"lookup|multi_hop|smalltalk","standalone_question":"...","sub_queries":[{"query":"...","purpose":"..."}]}`;

export const EVALUATOR_SYSTEM = `You check whether retrieved code is sufficient to answer a developer's question about a codebase.
Look at the evidence list (file paths, symbols, signatures, snippets). If a key part of the question is not covered — e.g. a function that is called but whose definition is missing, or one part of a multi-part question has no matching code — propose up to 3 follow-up search queries that name the missing symbols/concepts precisely.

Respond with JSON only:
{"sufficient":true|false,"missing":"<what is missing, or empty>","follow_up_queries":["..."]}`;

export const ANSWER_SYSTEM = `You are a senior engineer onboarding a developer onto this codebase. Answer using ONLY the numbered context chunks provided.

Guidelines:
- Cite evidence inline with bracketed chunk numbers, e.g. "Tokens are verified in \`verifySession\` [3]". Every factual claim about the code needs a citation.
- Reference concrete locations as \`path/to/file.ext:line\` and name the functions/classes involved.
- For multi-part questions, answer each part under its own short heading, and explain how the pieces connect (call flow / data flow).
- Quote short code excerpts from the context when it clarifies; never invent code, APIs, or files that are not in the context.
- If the context does not contain the answer, say exactly what is missing and where you would look next, instead of guessing.
- Be concise and concrete. Use Markdown.`;

export function chunkLabel(c: ChunkHit): string {
  return `${c.path}:${c.startLine}-${c.endLine} · ${c.kind} ${c.symbolPath || c.name}`;
}

/** Compact evidence digest for planner/evaluator prompts (cheap, fast-tier models). */
export function evidenceDigest(chunks: ChunkHit[], snippetChars = 260): string {
  return chunks
    .map((c, i) => {
      const sig = c.signature ? `\n   ${truncate(c.signature, 160)}` : "";
      const snippet = truncate(c.content.replace(/\s+/g, " "), snippetChars);
      return `${i + 1}. ${chunkLabel(c)}${sig}\n   ${snippet}`;
    })
    .join("\n");
}

export function contextBlock(chunks: ChunkHit[]): string {
  return chunks
    .map((c, i) => {
      const doc = c.docstring && c.kind !== "file" ? `// doc: ${truncate(c.docstring, 300)}\n` : "";
      return `[${i + 1}] ${chunkLabel(c)} (${c.language})\n\`\`\`${c.language}\n${doc}${c.content}\n\`\`\``;
    })
    .join("\n\n");
}
