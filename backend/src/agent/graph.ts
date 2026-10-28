import type { ChunkHit } from "../search/hybrid.js";

/** Calls that are language builtins / ubiquitous library calls rather than repo symbols. */
const IGNORED_CALLS = new Set(
  (
    "if for while switch catch return function typeof instanceof new await async yield super this self print println printf len str int float " +
    "bool list dict set tuple range map filter reduce forEach push pop shift unshift slice splice concat join split replace trim includes indexOf " +
    "keys values entries assign freeze parse stringify log warn error info debug require import then catch finally resolve reject setTimeout " +
    "setInterval clearTimeout fetch json send status next get post put delete patch use listen emit on once toString valueOf hasOwnProperty " +
    "isinstance hasattr getattr setattr super append extend items format sorted enumerate zip open close read write sizeof static_cast " +
    "make panic recover defer go fmt Println Printf Errorf Sprintf unwrap expect clone into iter collect Some Ok Err Box Vec String"
  ).split(/\s+/),
);

const CALL = /\b([A-Za-z_][A-Za-z0-9_]{2,})\s*(?:<[^<>()]*>)?\s*\(/g;

/**
 * Deterministic "graph hop": collects identifiers that retrieved chunks call but do not
 * define, ranked by frequency. Looking those up by exact symbol name follows the call
 * graph one level (e.g. middleware → the token validator it invokes).
 */
export function calledSymbols(chunks: ChunkHit[], limit = 10): string[] {
  const defined = new Set(chunks.map((c) => c.name));
  const counts = new Map<string, number>();
  for (const c of chunks) {
    if (c.kind === "file" || c.kind === "section") continue;
    const seenInChunk = new Set<string>();
    for (const m of c.content.matchAll(CALL)) {
      const name = m[1] as string;
      if (IGNORED_CALLS.has(name) || defined.has(name) || seenInChunk.has(name)) continue;
      // Skip the chunk's own definition line (`function foo(`, `def foo(`).
      if (name === c.name) continue;
      seenInChunk.add(name);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([n]) => n);
}
