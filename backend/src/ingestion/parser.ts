import path from "node:path";
import { createRequire } from "node:module";
import { Language, Parser, type Tree } from "web-tree-sitter";
import type { AstLanguageSpec } from "./languages.js";

const require = createRequire(import.meta.url);
const GRAMMAR_DIR = path.join(path.dirname(require.resolve("@vscode/tree-sitter-wasm/package.json")), "wasm");

let initPromise: Promise<void> | undefined;
const languages = new Map<string, Promise<Language>>();
const parsers = new Map<string, Parser>();

function init(): Promise<void> {
  initPromise ??= Parser.init();
  return initPromise;
}

async function loadLanguage(grammar: string): Promise<Language> {
  let p = languages.get(grammar);
  if (!p) {
    p = init().then(() => Language.load(path.join(GRAMMAR_DIR, `tree-sitter-${grammar}.wasm`)));
    languages.set(grammar, p);
    // Don't cache a failed load forever.
    p.catch(() => languages.delete(grammar));
  }
  return p;
}

/**
 * Parses source with the grammar for `spec`. Parsers are reused per grammar; parsing is
 * synchronous inside WASM, so concurrent callers on one event loop can't interleave.
 * The caller owns the returned tree and must call `tree.delete()`.
 */
export async function parseSource(spec: AstLanguageSpec, source: string): Promise<Tree> {
  const language = await loadLanguage(spec.grammar);
  let parser = parsers.get(spec.grammar);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(language);
    parsers.set(spec.grammar, parser);
  }
  const tree = parser.parse(source);
  if (!tree) throw new Error(`tree-sitter failed to parse (${spec.id})`);
  return tree;
}

/** Loads every grammar up front so a missing/incompatible wasm fails at boot, not mid-index. */
export async function warmUpParsers(specs: AstLanguageSpec[]): Promise<string[]> {
  const unique = [...new Set(specs.map((s) => s.grammar))];
  await Promise.all(unique.map(loadLanguage));
  return unique;
}
