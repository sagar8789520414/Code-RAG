import path from "node:path";
import type { Node } from "web-tree-sitter";
import type { ChunkKind } from "../db/models.js";
import { collapseWhitespace, truncate } from "../lib/text.js";
import { packRows, type RawChunk } from "./chunkTypes.js";
import type { AstLanguageSpec } from "./languages.js";
import { parseSource } from "./parser.js";

export interface AstChunkOptions {
  maxChars: number;
}

interface Scope {
  names: string[];
  inClass: boolean;
}

const SIGNATURE_MAX = 300;
const DOC_MAX = 1200;
const OUTLINE_IMPORTS_MAX = 40;
const MODULE_CHUNK_MIN_CHARS = 120;

export function cleanComment(text: string): string {
  return text
    .split("\n")
    .map((l) =>
      l
        .trim()
        .replace(/^\/\*\*?|\*\/$/g, "")
        .replace(/^(\/\/\/?|#|--|\*)\s?/, "")
        .trim(),
    )
    .filter(Boolean)
    .join("\n");
}

function cleanPythonString(text: string): string {
  return text
    .replace(/^[rRuUbBfF]{0,2}("""|'''|"|')/, "")
    .replace(/("""|'''|"|')$/, "")
    .trim();
}

/**
 * Extracts function/class/method-level chunks from a source file using its Tree-sitter AST.
 * Small classes stay whole; large classes become a skeleton chunk plus one chunk per member.
 * Oversized functions are split on statement boundaries. Code outside any definition is
 * grouped into `module` chunks, and every file gets an outline chunk (imports + symbols).
 */
export async function chunkAst(spec: AstLanguageSpec, source: string, filePath: string, opts: AstChunkOptions): Promise<RawChunk[]> {
  const tree = await parseSource(spec, source);
  try {
    return new AstChunker(spec, source, filePath, opts).run(tree.rootNode);
  } finally {
    tree.delete();
  }
}

class AstChunker {
  private readonly lines: string[];
  private readonly lineLengths: number[];
  private readonly consumed: boolean[];
  private readonly commentRows: boolean[];
  private readonly chunks: RawChunk[] = [];
  private readonly imports: string[] = [];
  private readonly outline: Array<{ depth: number; text: string }> = [];
  private moduleDoc = "";

  constructor(
    private readonly spec: AstLanguageSpec,
    private readonly source: string,
    private readonly filePath: string,
    private readonly opts: AstChunkOptions,
  ) {
    this.lines = source.split("\n");
    this.lineLengths = this.lines.map((l) => l.length);
    this.consumed = new Array(this.lines.length).fill(false);
    this.commentRows = new Array(this.lines.length).fill(false);
  }

  run(root: Node): RawChunk[] {
    this.moduleDoc = this.extractModuleDoc(root);
    this.visitContainer(root, { names: [], inClass: false });
    const leftovers = this.collectLeftovers();
    const outline = this.buildOutline(leftovers);
    return outline ? [outline, ...this.chunks] : this.chunks;
  }

  // ---------------------------------------------------------------- traversal

  private visitContainer(container: Node, scope: Scope): void {
    for (const child of container.namedChildren) this.visit(child, scope, child);
  }

  private visit(node: Node, scope: Scope, outer: Node): void {
    const { spec } = this;
    const t = node.type;

    if (spec.comments.has(t)) {
      this.markRows(this.commentRows, node.startPosition.row, this.endRow(node));
      return;
    }
    if (spec.imports.has(t)) {
      if (scope.names.length === 0 || !scope.inClass) this.imports.push(collapseWhitespace(node.text));
      this.markRows(this.consumed, node.startPosition.row, this.endRow(node));
      return;
    }
    if (spec.wrappers.has(t)) {
      for (const child of node.namedChildren) {
        if (this.isDefinitionLike(child)) return this.visit(child, scope, outer);
      }
      return; // e.g. `export { a, b }` — left for module chunks
    }
    if (spec.namespaces.has(t)) {
      const name = this.nameOf(node);
      const body = node.childForFieldName("body") ?? node;
      const names = name ? [...scope.names, name] : scope.names;
      this.visitContainer(body, { names, inClass: false });
      return;
    }
    if (t in spec.definitions) {
      this.emitDefinition(node, outer, scope);
      return;
    }
    if (spec.variableDeclarations?.has(t)) {
      const declarators = node.namedChildren.filter((c) => c.type === "variable_declarator");
      const fnDeclarators = declarators.filter((d) => this.isFunctionValue(d.childForFieldName("value")));
      for (const d of fnDeclarators) {
        const value = d.childForFieldName("value") as Node;
        // With a single declarator the whole statement (incl. `export const`) is the unit.
        this.emitDefinition(value, declarators.length === 1 ? outer : d, scope, d.childForFieldName("name")?.text);
      }
      return;
    }
    if (t === "expression_statement" && spec.functionValues) {
      // CommonJS / prototype style: `module.exports = function () {}`, `Foo.prototype.bar = () => {}`
      const expr = node.namedChild(0);
      if (expr?.type === "assignment_expression") {
        const right = expr.childForFieldName("right");
        const left = expr.childForFieldName("left");
        if (left && this.isFunctionValue(right)) this.emitDefinition(right as Node, outer, scope, left.text);
      }
    }
  }

  private isDefinitionLike(n: Node): boolean {
    const t = n.type;
    return t in this.spec.definitions || this.spec.wrappers.has(t) || !!this.spec.variableDeclarations?.has(t) || this.spec.namespaces.has(t);
  }

  private isFunctionValue(n: Node | null | undefined): boolean {
    return !!n && !!this.spec.functionValues?.has(n.type);
  }

  // ---------------------------------------------------------------- emission

  private emitDefinition(def: Node, outer: Node, scope: Scope, nameOverride?: string): void {
    const isClassLike = this.spec.classLike.has(def.type);
    let kind = this.kindOf(def);
    if (kind === "function" && scope.inClass) kind = "method";

    let rawName = nameOverride ?? this.nameOf(def) ?? "(anonymous)";
    let scopeNames = scope.names;
    // `void A::run()` in C++ and `func (s *Server) Handle()` in Go carry their owner in the definition itself.
    if (rawName.includes("::")) {
      const parts = rawName.split("::");
      rawName = parts.pop() as string;
      scopeNames = [...scopeNames, ...parts.filter(Boolean)];
      if (kind === "function") kind = "method";
    }
    const receiver = this.goReceiver(def);
    if (receiver) scopeNames = [...scopeNames, receiver];

    const comments = this.leadingComments(outer);
    const startRow = comments[0]?.startPosition.row ?? outer.startPosition.row;
    const endRow = this.endRow(outer);
    const docstring = this.docstringOf(def, comments);
    const signature = this.signatureOf(def, outer);
    const symbolPath = [...scopeNames, rawName].join(".");
    const base = {
      kind,
      name: rawName,
      symbolPath,
      parentScope: scopeNames.join("."),
      signature,
      docstring,
    };

    this.markRows(this.consumed, startRow, endRow);
    this.outline.push({ depth: scopeNames.length, text: `${signature || rawName}  [L${startRow + 1}-${endRow + 1}]` });
    const text = this.rows(startRow, endRow);

    if (isClassLike && text.length > this.opts.maxChars) {
      const body = def.childForFieldName("body") ?? def;
      const memberScopeName = def.type === "impl_item" ? (def.childForFieldName("type")?.text ?? rawName) : rawName;
      const skeletonIndex = this.chunks.length;
      this.visitContainer(body, { names: [...scopeNames, memberScopeName], inClass: true });
      const members = this.chunks.slice(skeletonIndex);
      const skeleton: RawChunk = {
        ...base,
        startLine: startRow + 1,
        endLine: endRow + 1,
        content: this.skeleton(startRow, endRow, members),
      };
      this.chunks.splice(skeletonIndex, 0, skeleton);
      return;
    }

    if (text.length <= this.opts.maxChars) {
      this.chunks.push({ ...base, startLine: startRow + 1, endLine: endRow + 1, content: text });
      return;
    }

    const breakRows = this.statementStartRows(def);
    const windows = packRows(this.lineLengths, startRow, endRow, this.opts.maxChars, (r) => breakRows.has(r));
    windows.forEach(([s, e], i) => {
      this.chunks.push({
        ...base,
        startLine: s + 1,
        endLine: e + 1,
        content: this.rows(s, e),
        part: { index: i + 1, total: windows.length },
      });
    });
  }

  /** Class text with each member body collapsed to its first line, so the class still reads as a unit. */
  private skeleton(startRow: number, endRow: number, members: RawChunk[]): string {
    const firsts = new Map<number, RawChunk>();
    for (const m of members) if (!m.part || m.part.index === 1) firsts.set(m.startLine - 1, m);
    const skip = new Set<number>();
    for (const m of members) for (let r = m.startLine - 1; r <= m.endLine - 1; r++) skip.add(r);
    const out: string[] = [];
    for (let r = startRow; r <= endRow; r++) {
      const member = firsts.get(r);
      if (member) {
        const indent = (this.lines[r] ?? "").match(/^\s*/)?.[0] ?? "";
        out.push(`${indent}${member.signature || member.name} … [L${member.startLine}-${member.endLine}]`);
      } else if (!skip.has(r)) {
        out.push(this.lines[r] ?? "");
      }
    }
    return truncate(out.join("\n"), this.opts.maxChars);
  }

  private statementStartRows(def: Node): Set<number> {
    let body = def.childForFieldName("body");
    // Go wraps statements in block > statement_list.
    if (body && body.namedChildCount === 1 && body.namedChild(0)?.type === "statement_list") body = body.namedChild(0);
    return new Set((body?.namedChildren ?? []).map((c) => c.startPosition.row));
  }

  // ---------------------------------------------------------------- leftovers and outline

  private collectLeftovers(): string[] {
    const smallSnippets: string[] = [];
    let r = 0;
    const n = this.lines.length;
    while (r < n) {
      if (this.consumed[r]) {
        r++;
        continue;
      }
      let e = r;
      while (e + 1 < n && !this.consumed[e + 1]) e++;
      this.emitLeftoverSegment(r, e, smallSnippets);
      r = e + 1;
    }
    return smallSnippets;
  }

  private emitLeftoverSegment(start: number, end: number, smallSnippets: string[]): void {
    let s = start;
    let e = end;
    while (s <= e && (this.lines[s] ?? "").trim() === "") s++;
    while (e >= s && (this.lines[e] ?? "").trim() === "") e--;
    if (s > e) return;
    let codeChars = 0;
    for (let r = s; r <= e; r++) if (!this.commentRows[r]) codeChars += (this.lines[r] ?? "").replace(/\s+/g, "").length;
    if (codeChars === 0) return; // comment-only segments (license headers) are noise
    const text = this.rows(s, e);
    if (codeChars < MODULE_CHUNK_MIN_CHARS) {
      smallSnippets.push(truncate(collapseWhitespace(text), 200));
      return;
    }
    const base = path.posix.basename(this.filePath);
    const windows = packRows(this.lineLengths, s, e, this.opts.maxChars, (row) => (this.lines[row] ?? "").trim() === "");
    windows.forEach(([ws, we], i) => {
      this.chunks.push({
        kind: "module",
        name: base,
        symbolPath: "(module)",
        parentScope: "",
        signature: `top-level code in ${base}`,
        docstring: "",
        startLine: ws + 1,
        endLine: we + 1,
        content: this.rows(ws, we),
        ...(windows.length > 1 ? { part: { index: i + 1, total: windows.length } } : {}),
      });
    });
  }

  private buildOutline(smallSnippets: string[]): RawChunk | undefined {
    if (this.lines.join("").trim() === "") return undefined;
    const parts = [`File: ${this.filePath}`];
    if (this.moduleDoc) parts.push(`Description: ${this.moduleDoc}`);
    if (this.imports.length) {
      parts.push("Imports:", ...this.imports.slice(0, OUTLINE_IMPORTS_MAX).map((i) => `  ${truncate(i, 160)}`));
      if (this.imports.length > OUTLINE_IMPORTS_MAX) parts.push(`  … ${this.imports.length - OUTLINE_IMPORTS_MAX} more`);
    }
    if (this.outline.length) parts.push("Symbols:", ...this.outline.map((o) => `${"  ".repeat(o.depth + 1)}${o.text}`));
    if (smallSnippets.length) parts.push("Top-level code:", ...smallSnippets.map((s) => `  ${s}`));
    const base = path.posix.basename(this.filePath);
    return {
      kind: "file",
      name: base,
      symbolPath: this.filePath,
      parentScope: "",
      signature: `file ${this.filePath}`,
      docstring: this.moduleDoc,
      startLine: 1,
      endLine: this.lines.length,
      content: truncate(parts.join("\n"), this.opts.maxChars),
    };
  }

  // ---------------------------------------------------------------- node helpers

  private kindOf(def: Node): ChunkKind {
    if (def.type === "type_declaration") {
      const specType = def.namedChildren.find((c) => c.type === "type_spec" || c.type === "type_alias")?.childForFieldName("type")?.type;
      if (specType === "struct_type") return "class";
      if (specType === "interface_type") return "interface";
      return "type";
    }
    if (this.spec.functionValues?.has(def.type)) return def.type === "class" ? "class" : "function";
    return this.spec.definitions[def.type] ?? "function";
  }

  nameOf(def: Node): string | undefined {
    const named = def.childForFieldName("name");
    if (named) return named.text;
    if (def.type === "function_definition") {
      // C/C++: walk declarator → function_declarator → declarator
      let d = def.childForFieldName("declarator");
      while (d && d.type !== "function_declarator") d = d.childForFieldName("declarator");
      const id = d?.childForFieldName("declarator");
      if (id) return id.text;
    }
    if (def.type === "impl_item") {
      const type = def.childForFieldName("type")?.text;
      const trait = def.childForFieldName("trait")?.text;
      return type ? (trait ? `${type}(${trait})` : type) : undefined;
    }
    if (def.type === "type_declaration") {
      return def.namedChildren.find((c) => c.type === "type_spec" || c.type === "type_alias")?.childForFieldName("name")?.text;
    }
    return undefined;
  }

  private goReceiver(def: Node): string | undefined {
    if (this.spec.id !== "go" || def.type !== "method_declaration") return undefined;
    const param = def.childForFieldName("receiver")?.namedChildren.find((c) => c.type === "parameter_declaration");
    return param?.childForFieldName("type")?.text.replace(/^\*/, "").replace(/\[.*$/, "");
  }

  private signatureOf(def: Node, outer: Node): string {
    const body = def.childForFieldName("body");
    const raw =
      body && body.startIndex > outer.startIndex
        ? this.source.slice(outer.startIndex, body.startIndex)
        : (this.source.slice(outer.startIndex, outer.endIndex).split("\n")[0] ?? "");
    // Drop the body opener (`{`, or Python's `:`) that precedes the body node.
    return truncate(collapseWhitespace(raw).replace(/\s*[{:]?\s*$/, ""), SIGNATURE_MAX);
  }

  private docstringOf(def: Node, comments: Node[]): string {
    if (this.spec.pythonDocstrings) {
      const first = def.childForFieldName("body")?.namedChild(0);
      const str = first?.type === "expression_statement" ? first.namedChild(0) : null;
      if (str?.type === "string") return truncate(cleanPythonString(str.text), DOC_MAX);
    }
    if (!comments.length) return "";
    return truncate(cleanComment(comments.map((c) => c.text).join("\n")), DOC_MAX);
  }

  private extractModuleDoc(root: Node): string {
    const first = root.namedChild(0);
    if (!first) return "";
    if (this.spec.pythonDocstrings && first.type === "expression_statement" && first.namedChild(0)?.type === "string") {
      return truncate(cleanPythonString(first.namedChild(0)!.text), DOC_MAX);
    }
    if (this.spec.comments.has(first.type) && first.startPosition.row === 0) {
      const text = cleanComment(first.text);
      // Skip license boilerplate; it says nothing about what the module does.
      if (!/copyright|license|spdx/i.test(text)) return truncate(text, DOC_MAX);
    }
    return "";
  }

  /** Comments immediately above `node` (no blank line between) that start their own line. */
  private leadingComments(node: Node): Node[] {
    const out: Node[] = [];
    let row = node.startPosition.row;
    let prev = node.previousNamedSibling;
    while (prev && this.spec.comments.has(prev.type) && this.endRow(prev) >= row - 1) {
      const lineStart = this.lines[prev.startPosition.row] ?? "";
      if (lineStart.slice(0, prev.startPosition.column).trim() !== "") break; // trailing comment of earlier code
      out.unshift(prev);
      row = prev.startPosition.row;
      prev = prev.previousNamedSibling;
    }
    return out;
  }

  /** Nodes that end at column 0 actually end on the previous line (e.g. Rust line comments). */
  private endRow(node: Node): number {
    const { row, column } = node.endPosition;
    return column === 0 && row > node.startPosition.row ? row - 1 : row;
  }

  private rows(start: number, end: number): string {
    return this.lines.slice(start, end + 1).join("\n");
  }

  private markRows(target: boolean[], start: number, end: number): void {
    for (let r = start; r <= end && r < target.length; r++) target[r] = true;
  }
}
