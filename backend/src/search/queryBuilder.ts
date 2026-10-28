import { splitIdentifier } from "../lib/text.js";
import { escapeTag } from "./redisIndex.js";

/** English + developer-question filler that carries no retrieval signal. */
const STOPWORDS = new Set(
  (
    "a an and are as at be but by for if in into is it no not of on or such that the their then there these they this to was will with " +
    "where what which who whom whose when why how does do did done doing can could should would may might must shall i me my we our you your " +
    "he she him her them its than too very just also about above after again against all am any because been before being below between both " +
    "each few from further here more most other out over own same so some only under until up while having has have had get gets got " +
    "code codebase repo repository project implement implemented implementation handled handle handles happen happens work works working " +
    "explain show find tell please located locate defined define used use uses using"
  ).split(/\s+/),
);

const MAX_TERMS = 24;

/**
 * Turns a natural-language/code question into an OR'd RediSearch full-text query. Identifiers
 * are kept whole and also split into sub-words (`validateToken` → validatetoken, validate, token)
 * to line up with the `tokens` field produced at index time.
 */
export function extractTerms(query: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const add = (t: string) => {
    const term = t.toLowerCase();
    if (term.length < 2 || STOPWORDS.has(term) || seen.has(term) || /^\d+$/.test(term)) return;
    seen.add(term);
    terms.push(term);
  };
  for (const m of query.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const word = m[0];
    const parts = splitIdentifier(word);
    if (parts.length > 1 || word.includes("_")) add(word.replace(/^_+|_+$/g, ""));
    for (const p of parts) add(p);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms.slice(0, MAX_TERMS);
}

export interface SearchFilters {
  language?: string;
  pathPrefix?: string;
  kinds?: string[];
}

/** RediSearch filter clause restricting results to one repo (plus optional filters). */
export function filterClause(repoId: string, filters: SearchFilters = {}): string {
  const parts = [`@repo:{${escapeTag(repoId)}}`];
  if (filters.language) parts.push(`@language:{${escapeTag(filters.language)}}`);
  if (filters.kinds?.length) parts.push(`@kind:{${filters.kinds.map(escapeTag).join("|")}}`);
  if (filters.pathPrefix) parts.push(`@pathTag:{${escapeTag(filters.pathPrefix.replace(/^\/+/, ""))}*}`);
  return parts.join(" ");
}

export function buildTextQuery(repoId: string, query: string, filters?: SearchFilters): string | undefined {
  const terms = extractTerms(query);
  if (!terms.length) return undefined;
  return `${filterClause(repoId, filters)} (${terms.join("|")})`;
}
