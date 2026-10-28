import type { ChunkKind } from "../db/models.js";

/** A semantic unit extracted from one file, before ids and embeddings are assigned. */
export interface RawChunk {
  kind: ChunkKind;
  name: string;
  symbolPath: string;
  parentScope: string;
  signature: string;
  docstring: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  content: string;
  part?: { index: number; total: number };
}

/**
 * Greedily packs rows [start, end] into windows of at most `maxChars`, preferring to cut
 * at rows where `isBreak` is true (statement starts, blank lines) as long as the window
 * keeps at least 40% of its budget. A single over-long row becomes its own window.
 */
export function packRows(
  lineLengths: readonly number[],
  start: number,
  end: number,
  maxChars: number,
  isBreak: (row: number) => boolean = () => false,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let s = start;
  while (s <= end) {
    let size = 0;
    let r = s;
    let lastBreak = -1;
    while (r <= end) {
      const len = (lineLengths[r] ?? 0) + 1;
      if (r > s && size + len > maxChars) break;
      if (r > s && isBreak(r)) lastBreak = r;
      size += len;
      r++;
    }
    if (r > end) {
      out.push([s, end]);
      break;
    }
    const cut = lastBreak > s && lastBreak - s >= (r - s) * 0.4 ? lastBreak : r;
    out.push([s, cut - 1]);
    s = cut;
  }
  return out;
}
