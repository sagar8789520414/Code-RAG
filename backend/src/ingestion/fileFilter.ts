import path from "node:path";
import { strategyForPath } from "./languages.js";

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "third_party",
  "third-party",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".gradle",
  "Pods",
  "DerivedData",
  ".cache",
  "bower_components",
  "jspm_packages",
  "site-packages",
]);

const EXCLUDED_FILES = [
  /\.min\.(js|css)$/i,
  /\.map$/i,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/i,
  /\.pb\.go$/,
  /_pb2(_grpc)?\.py$/,
  /\.generated\.\w+$/i,
  /\.snap$/i,
  /(^|\/)(CHANGELOG|HISTORY|CHANGES)(\.(md|rst|txt))?$/i,
];

export type SkipReason = "excluded_path" | "unsupported_type" | "too_large" | "binary" | "empty";

export function shouldConsiderPath(filePath: string, size: number, maxBytes: number): SkipReason | undefined {
  const segments = filePath.split("/");
  if (segments.slice(0, -1).some((s) => EXCLUDED_DIRS.has(s))) return "excluded_path";
  if (EXCLUDED_FILES.some((re) => re.test(filePath))) return "excluded_path";
  if (!strategyForPath(filePath)) return "unsupported_type";
  if (size > maxBytes) return "too_large";
  return undefined;
}

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Normalises to forward slashes and strips leading ./ so Mongo/Redis paths are stable. */
export function normalizeRepoPath(p: string): string {
  return path.posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\/+/, "");
}
