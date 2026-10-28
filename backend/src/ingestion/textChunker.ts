import path from "node:path";
import { truncate } from "../lib/text.js";
import { packRows, type RawChunk } from "./chunkTypes.js";

const isBlank = (lines: string[]) => (row: number) => (lines[row] ?? "").trim() === "";

/** Markdown split by heading hierarchy; each section carries its heading breadcrumb. */
export function chunkMarkdown(source: string, filePath: string, maxChars: number): RawChunk[] {
  const lines = source.split("\n");
  const lengths = lines.map((l) => l.length);
  const headings: Array<{ row: number; level: number; title: string }> = [];
  let inFence = false;
  lines.forEach((line, row) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) headings.push({ row, level: m[1]!.length, title: m[2]! });
  });

  const base = path.posix.basename(filePath);
  const sections: Array<{ start: number; end: number; title: string; breadcrumb: string }> = [];
  if (!headings.length || headings[0]!.row > 0) {
    sections.push({ start: 0, end: (headings[0]?.row ?? lines.length) - 1, title: base, breadcrumb: base });
  }
  const stack: Array<{ level: number; title: string }> = [];
  headings.forEach((h, i) => {
    while (stack.length && stack[stack.length - 1]!.level >= h.level) stack.pop();
    stack.push({ level: h.level, title: h.title });
    const end = (headings[i + 1]?.row ?? lines.length) - 1;
    sections.push({ start: h.row, end, title: h.title, breadcrumb: stack.map((s) => s.title).join(" > ") });
  });

  const chunks: RawChunk[] = [];
  for (const sec of sections) {
    const text = lines.slice(sec.start, sec.end + 1).join("\n");
    if (text.trim().length < 20) continue;
    const windows = packRows(lengths, sec.start, sec.end, maxChars, isBlank(lines));
    windows.forEach(([s, e], i) => {
      chunks.push({
        kind: "section",
        name: sec.title,
        symbolPath: sec.breadcrumb,
        parentScope: sec.breadcrumb.split(" > ").slice(0, -1).join(" > "),
        signature: truncate(sec.breadcrumb, 300),
        docstring: "",
        startLine: s + 1,
        endLine: e + 1,
        content: lines.slice(s, e + 1).join("\n"),
        ...(windows.length > 1 ? { part: { index: i + 1, total: windows.length } } : {}),
      });
    });
  }
  return chunks;
}

/** Line windows that prefer paragraph breaks; used for languages without a grammar. */
export function chunkLines(source: string, filePath: string, maxChars: number): RawChunk[] {
  const lines = source.split("\n");
  if (source.trim() === "") return [];
  const windows = packRows(
    lines.map((l) => l.length),
    0,
    lines.length - 1,
    maxChars,
    isBlank(lines),
  );
  return windows.map(([s, e], i) => blockChunk(filePath, lines, s, e, i, windows.length));
}

/**
 * Naive fixed-size windows with overlap and no structural awareness. Kept as the
 * baseline strategy so benchmarks can quantify what AST chunking buys.
 */
export function chunkFixed(source: string, filePath: string, maxChars: number, overlapChars = Math.floor(maxChars * 0.15)): RawChunk[] {
  const lines = source.split("\n");
  if (source.trim() === "") return [];
  const out: RawChunk[] = [];
  const windows: Array<[number, number]> = [];
  let s = 0;
  while (s < lines.length) {
    let size = 0;
    let e = s;
    while (e < lines.length && (e === s || size + (lines[e]?.length ?? 0) + 1 <= maxChars)) size += (lines[e++]?.length ?? 0) + 1;
    windows.push([s, e - 1]);
    if (e >= lines.length) break;
    // step back so consecutive windows share ~overlapChars of context
    let back = e;
    let overlap = 0;
    while (back - 1 > s && overlap + (lines[back - 1]?.length ?? 0) + 1 <= overlapChars) overlap += (lines[--back]?.length ?? 0) + 1;
    s = back;
  }
  windows.forEach(([ws, we], i) => out.push(blockChunk(filePath, lines, ws, we, i, windows.length)));
  return out;
}

function blockChunk(filePath: string, lines: string[], s: number, e: number, i: number, total: number): RawChunk {
  const base = path.posix.basename(filePath);
  return {
    kind: "block",
    name: base,
    symbolPath: `${filePath}#L${s + 1}`,
    parentScope: "",
    signature: `${base} lines ${s + 1}-${e + 1}`,
    docstring: "",
    startLine: s + 1,
    endLine: e + 1,
    content: lines.slice(s, e + 1).join("\n"),
    ...(total > 1 ? { part: { index: i + 1, total } } : {}),
  };
}
