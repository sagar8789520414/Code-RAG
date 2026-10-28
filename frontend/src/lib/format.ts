export const shortSha = (sha?: string) => (sha ? sha.slice(0, 7) : "—");

export function timeAgo(iso?: string): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export const ms = (n?: number) => (n === undefined ? "—" : n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`);

export const pct = (x?: number) => (x === undefined ? "—" : `${(x * 100).toFixed(1)}%`);

/** Maps backend language ids onto prism-react-renderer grammar names. */
export function prismLanguage(lang: string): string {
  const map: Record<string, string> = {
    javascript: "jsx",
    typescript: "tsx",
    python: "python",
    c: "c",
    cpp: "cpp",
    go: "go",
    rust: "rust",
    java: "java",
    kotlin: "kotlin",
    swift: "swift",
    csharp: "csharp",
    ruby: "ruby",
    php: "php",
    bash: "bash",
    markdown: "markdown",
    yaml: "yaml",
    json: "json",
    graphql: "graphql",
    sql: "sql",
    css: "css",
    scss: "scss",
    html: "markup",
  };
  return map[lang] ?? "plaintext";
}

export const kindColor: Record<string, string> = {
  function: "text-sky-300 bg-sky-500/10 ring-sky-500/30",
  method: "text-cyan-300 bg-cyan-500/10 ring-cyan-500/30",
  class: "text-violet-300 bg-violet-500/10 ring-violet-500/30",
  interface: "text-fuchsia-300 bg-fuchsia-500/10 ring-fuchsia-500/30",
  type: "text-pink-300 bg-pink-500/10 ring-pink-500/30",
  enum: "text-rose-300 bg-rose-500/10 ring-rose-500/30",
  module: "text-amber-300 bg-amber-500/10 ring-amber-500/30",
  file: "text-slate-300 bg-slate-500/10 ring-slate-500/30",
  section: "text-emerald-300 bg-emerald-500/10 ring-emerald-500/30",
  block: "text-slate-300 bg-slate-500/10 ring-slate-500/30",
  imports: "text-slate-300 bg-slate-500/10 ring-slate-500/30",
};
