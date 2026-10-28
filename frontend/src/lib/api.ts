import type { Benchmark, BenchmarkItem, Commit, FileView, Health, Job, Repo, SearchInspection } from "./types";
import { loadSettings } from "./settings";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

let settings = loadSettings();
export function setApiSettings(s: typeof settings) {
  settings = s;
}

const url = (path: string) => `${settings.apiUrl}${path}`;

function headers(json: boolean): HeadersInit {
  const h: Record<string, string> = {};
  if (json) h["Content-Type"] = "application/json";
  if (settings.adminKey) h["x-api-key"] = settings.adminKey;
  return h;
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url(path), { method, headers: headers(body !== undefined), body: body === undefined ? undefined : JSON.stringify(body), signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(`Cannot reach the API at ${settings.apiUrl || window.location.origin}. Is the backend running?`, 0, "network");
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const e = (data as { error?: { message?: string; code?: string; issues?: Array<{ path: string; message: string }> } } | undefined)?.error;
    const issues = e?.issues?.map((i) => `${i.path}: ${i.message}`).join("; ");
    throw new ApiError(issues ? `${e?.message}: ${issues}` : (e?.message ?? `HTTP ${res.status}`), res.status, e?.code);
  }
  return data as T;
}

export const api = {
  health: () => request<Health>("GET", "/api/health"),
  repos: () => request<{ repos: Repo[] }>("GET", "/api/repos").then((r) => r.repos),
  repo: (id: string) => request<{ repo: Repo; jobs: Job[]; commits: Commit[] }>("GET", `/api/repos/${id}`),
  addRepo: (body: { url: string; branch?: string; name?: string; chunking: "ast" | "fixed" }) => request<{ repo: Repo; job: Job }>("POST", "/api/repos", body),
  syncRepo: (id: string, full = false) => request<{ job: Job }>("POST", `/api/repos/${id}/sync`, { full }),
  deleteRepo: (id: string) => request<void>("DELETE", `/api/repos/${id}`),
  tree: (id: string) => request<{ files: Array<{ path: string; language: string; size: number; chunks: number }> }>("GET", `/api/repos/${id}/tree`).then((r) => r.files),
  file: (id: string, path: string) => request<FileView>("GET", `/api/repos/${id}/file?path=${encodeURIComponent(path)}`),
  commits: (id: string, limit = 20) => request<{ commits: Commit[] }>("GET", `/api/repos/${id}/commits?limit=${limit}`).then((r) => r.commits),
  job: (id: string) => request<Job>("GET", `/api/jobs/${id}`),
  search: (body: { repoId: string; query: string; k: number; mode: string; rerank: boolean; filters?: Record<string, unknown> }) =>
    request<SearchInspection>("POST", "/api/search", body),
  benchmarks: (repoId: string) => request<{ benchmarks: Benchmark[] }>("GET", `/api/benchmarks?repoId=${repoId}`).then((r) => r.benchmarks),
  benchmark: (id: string) => request<Benchmark>("GET", `/api/benchmarks/${id}`),
  benchmarkSamples: () =>
    request<{ samples: Array<{ file: string; repo?: string; description?: string; size: number; items: BenchmarkItem[] }> }>("GET", "/api/benchmarks/samples").then((r) => r.samples),
  runBenchmark: (body: { repoId: string; name: string; dataset: BenchmarkItem[]; modes: string[]; k: number }) => request<{ benchmark: Benchmark; job: Job }>("POST", "/api/benchmarks", body),
};

export interface StreamHandlers {
  onEvent: (event: string, data: unknown) => void;
}

/** POSTs and parses a `text/event-stream` response body (EventSource can't POST). */
export async function postStream(path: string, body: unknown, handlers: StreamHandlers, signal: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url(path), { method: "POST", headers: { ...headers(true), Accept: "text/event-stream" }, body: JSON.stringify(body), signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError("Cannot reach the API. Is the backend running?", 0, "network");
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let message = `HTTP ${res.status}`;
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(message, res.status);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (!data.length) continue; // keep-alive comment
      try {
        handlers.onEvent(event, JSON.parse(data.join("\n")));
      } catch {
        // ignore malformed event
      }
    }
  }
}
