import path from "node:path";
import type { ChunkKind } from "../db/models.js";

/**
 * Declarative description of how to find semantic units in one Tree-sitter grammar.
 * Node type names come from the grammars shipped in @vscode/tree-sitter-wasm.
 */
export interface AstLanguageSpec {
  id: string;
  /** wasm file stem: tree-sitter-<grammar>.wasm */
  grammar: string;
  /** Node types that become chunks, and the kind they map to. */
  definitions: Record<string, ChunkKind>;
  /** Definitions whose body holds member definitions (classes, traits, impls). */
  classLike: ReadonlySet<string>;
  /** Scoping containers that are not chunks themselves (namespaces, modules). */
  namespaces: ReadonlySet<string>;
  /** Nodes that wrap a definition and whose text belongs to it (export, decorators, templates). */
  wrappers: ReadonlySet<string>;
  imports: ReadonlySet<string>;
  comments: ReadonlySet<string>;
  /** JS/TS: `const x = () => {}` declarations whose value may be a function or class. */
  variableDeclarations?: ReadonlySet<string>;
  functionValues?: ReadonlySet<string>;
  /** Python-style docstrings: first string statement in the body. */
  pythonDocstrings?: boolean;
}

const set = (...items: string[]) => new Set(items);

const jsLike = (id: string, grammar: string): AstLanguageSpec => ({
  id,
  grammar,
  definitions: {
    function_declaration: "function",
    generator_function_declaration: "function",
    class_declaration: "class",
    abstract_class_declaration: "class",
    method_definition: "method",
    interface_declaration: "interface",
    type_alias_declaration: "type",
    enum_declaration: "enum",
  },
  classLike: set("class_declaration", "abstract_class_declaration", "class"),
  namespaces: set("internal_module", "module"),
  wrappers: set("export_statement"),
  imports: set("import_statement"),
  comments: set("comment"),
  variableDeclarations: set("lexical_declaration", "variable_declaration"),
  functionValues: set("arrow_function", "function_expression", "function", "generator_function", "class"),
});

export const AST_LANGUAGES: Record<string, AstLanguageSpec> = {
  javascript: jsLike("javascript", "javascript"),
  typescript: jsLike("typescript", "typescript"),
  tsx: jsLike("tsx", "tsx"),
  python: {
    id: "python",
    grammar: "python",
    definitions: { function_definition: "function", class_definition: "class" },
    classLike: set("class_definition"),
    namespaces: set(),
    wrappers: set("decorated_definition"),
    imports: set("import_statement", "import_from_statement", "future_import_statement"),
    comments: set("comment"),
    pythonDocstrings: true,
  },
  cpp: {
    id: "cpp",
    grammar: "cpp",
    definitions: {
      function_definition: "function",
      class_specifier: "class",
      struct_specifier: "class",
      union_specifier: "type",
      enum_specifier: "enum",
    },
    classLike: set("class_specifier", "struct_specifier"),
    namespaces: set("namespace_definition", "linkage_specification"),
    wrappers: set("template_declaration"),
    imports: set("preproc_include", "using_declaration"),
    comments: set("comment"),
  },
  java: {
    id: "java",
    grammar: "java",
    definitions: {
      class_declaration: "class",
      interface_declaration: "interface",
      enum_declaration: "enum",
      record_declaration: "class",
      annotation_type_declaration: "interface",
      method_declaration: "method",
      constructor_declaration: "method",
    },
    classLike: set("class_declaration", "interface_declaration", "enum_declaration", "record_declaration"),
    namespaces: set(),
    wrappers: set(),
    imports: set("import_declaration", "package_declaration"),
    comments: set("comment", "line_comment", "block_comment"),
  },
  go: {
    id: "go",
    grammar: "go",
    definitions: { function_declaration: "function", method_declaration: "method", type_declaration: "type" },
    classLike: set(),
    namespaces: set(),
    wrappers: set(),
    imports: set("import_declaration", "package_clause"),
    comments: set("comment"),
  },
  rust: {
    id: "rust",
    grammar: "rust",
    definitions: {
      function_item: "function",
      function_signature_item: "function",
      struct_item: "class",
      enum_item: "enum",
      union_item: "type",
      trait_item: "interface",
      impl_item: "class",
      type_item: "type",
      macro_definition: "function",
    },
    classLike: set("trait_item", "impl_item"),
    namespaces: set("mod_item", "foreign_mod_item"),
    wrappers: set(),
    imports: set("use_declaration", "extern_crate_declaration"),
    comments: set("line_comment", "block_comment"),
  },
  csharp: {
    id: "csharp",
    grammar: "c-sharp",
    definitions: {
      class_declaration: "class",
      struct_declaration: "class",
      record_declaration: "class",
      interface_declaration: "interface",
      enum_declaration: "enum",
      method_declaration: "method",
      constructor_declaration: "method",
      operator_declaration: "method",
      local_function_statement: "function",
    },
    classLike: set("class_declaration", "struct_declaration", "record_declaration", "interface_declaration"),
    namespaces: set("namespace_declaration", "file_scoped_namespace_declaration"),
    wrappers: set(),
    imports: set("using_directive"),
    comments: set("comment"),
  },
  ruby: {
    id: "ruby",
    grammar: "ruby",
    definitions: { method: "method", singleton_method: "method", class: "class", module: "module" },
    classLike: set("class", "module"),
    namespaces: set(),
    wrappers: set(),
    imports: set(),
    comments: set("comment"),
  },
  php: {
    id: "php",
    grammar: "php",
    definitions: {
      function_definition: "function",
      class_declaration: "class",
      interface_declaration: "interface",
      trait_declaration: "class",
      enum_declaration: "enum",
      method_declaration: "method",
    },
    classLike: set("class_declaration", "interface_declaration", "trait_declaration", "enum_declaration"),
    namespaces: set(),
    wrappers: set(),
    imports: set("namespace_use_declaration", "namespace_definition"),
    comments: set("comment"),
  },
  bash: {
    id: "bash",
    grammar: "bash",
    definitions: { function_definition: "function" },
    classLike: set(),
    namespaces: set(),
    wrappers: set(),
    imports: set(),
    comments: set("comment"),
  },
};

export type FileStrategy = { kind: "ast"; spec: AstLanguageSpec; language: string } | { kind: "markdown"; language: string } | { kind: "text"; language: string };

/** Languages without a bundled grammar are still indexed with line-window chunking. */
const EXTENSIONS: Record<string, { language: string; ast?: string; markdown?: boolean }> = {
  ".js": { language: "javascript", ast: "javascript" },
  ".mjs": { language: "javascript", ast: "javascript" },
  ".cjs": { language: "javascript", ast: "javascript" },
  ".jsx": { language: "javascript", ast: "tsx" },
  ".ts": { language: "typescript", ast: "typescript" },
  ".mts": { language: "typescript", ast: "typescript" },
  ".cts": { language: "typescript", ast: "typescript" },
  ".tsx": { language: "typescript", ast: "tsx" },
  ".py": { language: "python", ast: "python" },
  ".pyi": { language: "python", ast: "python" },
  ".c": { language: "c", ast: "cpp" },
  ".h": { language: "c", ast: "cpp" },
  ".cc": { language: "cpp", ast: "cpp" },
  ".cpp": { language: "cpp", ast: "cpp" },
  ".cxx": { language: "cpp", ast: "cpp" },
  ".hh": { language: "cpp", ast: "cpp" },
  ".hpp": { language: "cpp", ast: "cpp" },
  ".hxx": { language: "cpp", ast: "cpp" },
  ".java": { language: "java", ast: "java" },
  ".go": { language: "go", ast: "go" },
  ".rs": { language: "rust", ast: "rust" },
  ".cs": { language: "csharp", ast: "csharp" },
  ".rb": { language: "ruby", ast: "ruby" },
  ".php": { language: "php", ast: "php" },
  ".sh": { language: "bash", ast: "bash" },
  ".bash": { language: "bash", ast: "bash" },
  ".kt": { language: "kotlin" },
  ".kts": { language: "kotlin" },
  ".swift": { language: "swift" },
  ".scala": { language: "scala" },
  ".dart": { language: "dart" },
  ".lua": { language: "lua" },
  ".ex": { language: "elixir" },
  ".exs": { language: "elixir" },
  ".vue": { language: "vue" },
  ".svelte": { language: "svelte" },
  ".sql": { language: "sql" },
  ".proto": { language: "protobuf" },
  ".graphql": { language: "graphql" },
  ".gql": { language: "graphql" },
  ".yaml": { language: "yaml" },
  ".yml": { language: "yaml" },
  ".toml": { language: "toml" },
  ".ini": { language: "ini" },
  ".cfg": { language: "ini" },
  ".css": { language: "css" },
  ".scss": { language: "scss" },
  ".html": { language: "html" },
  ".md": { language: "markdown", markdown: true },
  ".mdx": { language: "markdown", markdown: true },
  ".rst": { language: "rst" },
  ".txt": { language: "text" },
};

const SPECIAL_FILES: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "make",
  "package.json": "json",
  "tsconfig.json": "json",
  "pyproject.toml": "toml",
  "cargo.toml": "toml",
  "go.mod": "go-mod",
  ".env.example": "dotenv",
};

export function strategyForPath(filePath: string): FileStrategy | undefined {
  const base = path.posix.basename(filePath).toLowerCase();
  const special = SPECIAL_FILES[base];
  if (special) return { kind: "text", language: special };
  const entry = EXTENSIONS[path.posix.extname(base)];
  if (!entry) return undefined;
  if (entry.markdown) return { kind: "markdown", language: entry.language };
  const spec = entry.ast ? AST_LANGUAGES[entry.ast] : undefined;
  return spec ? { kind: "ast", spec, language: entry.language } : { kind: "text", language: entry.language };
}
