import crypto from "node:crypto";

export const sha1 = (s: string) => crypto.createHash("sha1").update(s).digest("hex");
export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Cheap token estimate (~3.5 chars/token for code); used for context budgeting only. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 3.5);

/**
 * Splits identifiers into lower-case sub-words so BM25 can match natural-language
 * queries against code: `validateSessionToken` → validate session token,
 * `HTTPServer_v2` → http server v2.
 */
export function splitIdentifier(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((p) => p.toLowerCase())
    .filter((p) => p.length > 1);
}

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]{2,}/g;

/** Distinct sub-word tokens of every identifier in `text`, for the BM25 `tokens` field. */
export function identifierTokens(text: string, limit = 400): string {
  const out = new Set<string>();
  for (const m of text.matchAll(IDENT)) {
    for (const part of splitIdentifier(m[0])) {
      out.add(part);
      if (out.size >= limit) return [...out].join(" ");
    }
  }
  return [...out].join(" ");
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Bounded-concurrency map that preserves input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
