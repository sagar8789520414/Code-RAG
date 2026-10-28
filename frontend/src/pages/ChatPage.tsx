import clsx from "clsx";
import { ArrowDown, ArrowUp, Bot, Bug, Check, Compass, Copy, Eraser, GitBranch, KeyRound, MessageSquareCode, Search, Settings2, Sparkles, Square, Workflow } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { AgentTimeline } from "../components/AgentTimeline";
import { Markdown } from "../components/Markdown";
import { SourceList } from "../components/SourceList";
import { Button, EmptyState, ErrorNote, Spinner } from "../components/ui";
import { postStream } from "../lib/api";
import { ms, shortSha } from "../lib/format";
import type { AgentStep, Repo, SourceRef } from "../lib/types";
import { useApp } from "../state/AppContext";
import type { ChatMessage } from "../state/chatReducer";

const EXAMPLES = [
  { icon: Compass, title: "Tour the codebase", q: "Give me a high-level tour of this codebase: main modules and how a request flows through them." },
  { icon: KeyRound, title: "Trace auth", q: "Where is authentication handled and how is the session token validated?" },
  { icon: Bug, title: "Error handling", q: "How are errors handled and propagated to the caller?" },
  { icon: Settings2, title: "Make a change", q: "Which functions would I change to add a new configuration option?" },
];

const PIPELINE = [
  { icon: Workflow, label: "Plan sub-queries" },
  { icon: Search, label: "BM25 + vector · RRF" },
  { icon: GitBranch, label: "Follow call graph" },
  { icon: Sparkles, label: "Cited answer" },
];

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-slate-400 hover:bg-slate-800 hover:text-slate-100"
      aria-label="Copy answer"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function AssistantMessage({ m, repoId }: { m: ChatMessage; repoId: string }) {
  const { openPreview } = useApp();
  const [activeN, setActiveN] = useState<number>();
  const open = (s: SourceRef) => {
    setActiveN(s.n);
    openPreview({ repoId, path: s.path, startLine: s.startLine, endLine: s.endLine });
  };
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-linear-to-br from-violet-500/25 to-sky-500/20 text-violet-200 ring-1 ring-violet-400/20">
        <Bot className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <AgentTimeline steps={m.steps} live={m.status === "streaming" && !m.content} onOpen={(path, lines) => openPreview({ repoId, path, startLine: lines[0], endLine: lines[1] })} />
        {m.content ? (
          <Markdown content={m.content} sources={m.sources} onCite={open} />
        ) : (
          m.status === "streaming" && (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Spinner /> Researching the codebase…
            </div>
          )
        )}
        {m.status === "streaming" && m.content && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-sky-400 align-middle" />}
        {m.status === "error" && (
          <div className="mt-2">
            <ErrorNote error={m.error} />
          </div>
        )}
        {m.status === "cancelled" && <div className="mt-2 text-xs text-slate-500">Stopped.</div>}
        <SourceList sources={m.sources} onOpen={open} activeN={activeN} />
        {m.status !== "streaming" && m.content && (
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-800/70 pt-2.5 text-[11px] text-slate-500">
            <CopyButton text={m.content} />
            {m.meta?.provider && (
              <span className="rounded-md bg-slate-900 px-1.5 py-0.5 ring-1 ring-slate-800">
                {m.meta.provider} · {m.meta.model}
              </span>
            )}
            {m.meta?.fallback && <span className="text-amber-300/80">fallback: {m.meta.fallback}</span>}
            {m.meta?.timings?.totalMs !== undefined && <span>total {ms(m.meta.timings.totalMs)}</span>}
            {m.meta?.timings?.retrieveMs !== undefined && <span>retrieval {ms(m.meta.timings.retrieveMs)}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function Welcome({ repo, onAsk }: { repo?: Repo; onAsk: (q: string) => void }) {
  const languages = Object.entries(repo?.stats.languages ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  return (
    <div className="pt-10 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-linear-to-br from-sky-500/30 to-violet-500/30 ring-1 ring-sky-400/30">
        <MessageSquareCode className="h-6 w-6 text-sky-200" />
      </div>
      <h2 className="mt-4 bg-linear-to-r from-sky-200 via-cyan-100 to-violet-200 bg-clip-text text-2xl font-semibold tracking-tight text-transparent">
        Ask anything about {repo?.name ?? "this codebase"}
      </h2>
      <p className="mx-auto mt-2 max-w-lg text-sm text-slate-400">The agent breaks your question down, searches the AST-chunked index, follows the call graph, and cites every claim back to file and line.</p>

      {repo && (
        <div className="mt-4 flex flex-wrap justify-center gap-1.5 text-[11px] text-slate-400">
          <span className="rounded-full bg-slate-900 px-2.5 py-1 ring-1 ring-slate-800">{repo.stats.files.toLocaleString()} files</span>
          <span className="rounded-full bg-slate-900 px-2.5 py-1 ring-1 ring-slate-800">{repo.stats.chunks.toLocaleString()} chunks</span>
          {languages.map(([l, n]) => (
            <span key={l} className="rounded-full bg-slate-900 px-2.5 py-1 ring-1 ring-slate-800">
              {l} · {n}
            </span>
          ))}
          <span className="rounded-full bg-slate-900 px-2.5 py-1 font-mono ring-1 ring-slate-800">@ {shortSha(repo.lastIndexedCommit)}</span>
        </div>
      )}

      <div className="mt-8 grid gap-2.5 text-left sm:grid-cols-2">
        {EXAMPLES.map(({ icon: Icon, title, q }) => (
          <button
            key={q}
            onClick={() => onAsk(q)}
            className="group flex gap-3 rounded-xl border border-slate-800 bg-slate-900/50 p-3.5 transition-colors hover:border-sky-500/40 hover:bg-slate-900"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-800 text-slate-300 group-hover:bg-sky-500/15 group-hover:text-sky-300">
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-slate-200">{title}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-slate-400">{q}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-center gap-x-2 gap-y-2 text-[11px] text-slate-500">
        {PIPELINE.map(({ icon: Icon, label }, i) => (
          <span key={label} className="inline-flex items-center gap-2">
            {i > 0 && <span className="text-slate-700">→</span>}
            <span className="inline-flex items-center gap-1.5">
              <Icon className="h-3.5 w-3.5 text-slate-400" /> {label}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function ChatPage() {
  const { repo, repoId, chats, dispatchChat, reposLoading } = useApp();
  const [input, setInput] = useState("");
  const [rerank, setRerank] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messages = repoId ? (chats[repoId] ?? []) : [];
  const streaming = messages.some((m) => m.status === "streaming");
  const last = messages.at(-1);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  // Follow the stream only while the reader is already at the bottom; never yank them back up.
  useEffect(() => {
    if (atBottom) scrollToBottom();
  }, [messages.length, last?.content.length, last?.steps.length, last?.sources.length, atBottom, scrollToBottom]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  useEffect(() => () => abortRef.current?.abort(), []);

  if (!reposLoading && !repoId) {
    return (
      <EmptyState icon={<MessageSquareCode className="h-10 w-10" />} title="Index a repository to start asking questions">
        Add a Git repository on the{" "}
        <Link to="/repos" className="text-sky-300 hover:underline">
          Repositories
        </Link>{" "}
        page. It is parsed with Tree-sitter, embedded, and indexed for hybrid search.
      </EmptyState>
    );
  }

  async function ask(question: string) {
    if (!repoId || !question.trim() || streaming) return;
    const history = messages
      .filter((m) => m.status === "done" && m.content)
      .slice(-6)
      .map((m) => ({ role: m.role, content: m.content }));
    const id = uid();
    dispatchChat({ type: "user", repoId, id: uid(), content: question.trim() });
    dispatchChat({ type: "assistant_start", repoId, id });
    setInput("");
    setAtBottom(true);
    const ctl = new AbortController();
    abortRef.current = ctl;
    let finished = false;
    try {
      await postStream(
        "/api/query/stream",
        { repoId, question: question.trim(), history, rerank },
        {
          onEvent: (event, data) => {
            const d = data as Record<string, unknown>;
            if (event === "step") dispatchChat({ type: "step", repoId, id, step: d.step as AgentStep });
            else if (event === "sources") dispatchChat({ type: "sources", repoId, id, sources: d.sources as SourceRef[] });
            else if (event === "token") dispatchChat({ type: "token", repoId, id, text: d.text as string });
            else if (event === "done") {
              finished = true;
              dispatchChat({
                type: "done",
                repoId,
                id,
                answer: d.answer as string,
                meta: { queryId: d.queryId as string, provider: d.provider as string, model: d.model as string, fallback: d.fallback as string | undefined, timings: d.timings as Record<string, number> },
              });
            } else if (event === "error") {
              finished = true;
              dispatchChat({ type: "error", repoId, id, error: d.message as string });
            }
          },
        },
        ctl.signal,
      );
      if (!finished) dispatchChat({ type: "error", repoId, id, error: "The stream ended unexpectedly." });
    } catch (err) {
      if ((err as Error).name === "AbortError") dispatchChat({ type: "cancel", repoId, id });
      else dispatchChat({ type: "error", repoId, id, error: (err as Error).message });
    } finally {
      abortRef.current = null;
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-slate-800/80 bg-slate-950/60 px-5 py-3 backdrop-blur">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{repo?.name ?? "…"}</h1>
          <p className="truncate text-xs text-slate-500">Multi-hop agent · hybrid BM25 + vector search · RRF · LLM rerank</p>
        </div>
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-slate-900" title="Rerank search results with an LLM judge">
          <input type="checkbox" checked={rerank} onChange={(e) => setRerank(e.target.checked)} className="accent-sky-500" /> Rerank
        </label>
        {repoId && messages.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => dispatchChat({ type: "clear", repoId })} disabled={streaming}>
            <Eraser className="h-3.5 w-3.5" /> Clear
          </Button>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="h-full overflow-y-auto"
          onScroll={(e) => {
            const el = e.currentTarget;
            setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
          }}
        >
          <div className="mx-auto max-w-4xl space-y-8 px-5 py-6">
            {repo && repo.status !== "ready" && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                This repository is <b>{repo.status}</b>
                {repo.activeJob ? ` — ${repo.activeJob.progress.message ?? repo.activeJob.progress.phase}` : ""}. Answers may be incomplete until indexing finishes.
              </div>
            )}
            {!messages.length && <Welcome repo={repo} onAsk={(q) => void ask(q)} />}
            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-sky-500/12 px-4 py-2.5 text-sm leading-relaxed text-slate-100 ring-1 ring-sky-500/25">{m.content}</div>
                </div>
              ) : (
                <AssistantMessage key={m.id} m={m} repoId={repoId!} />
              ),
            )}
          </div>
        </div>
        {!atBottom && messages.length > 0 && (
          <button
            onClick={() => scrollToBottom(true)}
            className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-slate-800/95 px-3 py-1.5 text-xs text-slate-200 shadow-lg ring-1 ring-slate-700 backdrop-blur hover:bg-slate-700"
          >
            <ArrowDown className="h-3.5 w-3.5" /> {streaming ? "Follow answer" : "Jump to latest"}
          </button>
        )}
      </div>

      <form
        className="border-t border-slate-800/80 bg-slate-950/60 px-5 pb-3 pt-3 backdrop-blur"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(input);
        }}
      >
        <div className="mx-auto max-w-4xl">
          <div className="flex items-end gap-2 rounded-2xl border border-slate-700/80 bg-slate-900 p-2 shadow-lg shadow-black/20 transition-colors focus-within:border-sky-500/70 focus-within:ring-2 focus-within:ring-sky-500/15">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void ask(input);
                }
              }}
              rows={1}
              placeholder={`Ask about ${repo?.name ?? "the codebase"}…`}
              className="max-h-[200px] min-h-[36px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
              aria-label="Question"
            />
            {streaming ? (
              <Button type="button" variant="secondary" onClick={() => abortRef.current?.abort()} aria-label="Stop generating" className="rounded-xl">
                <Square className="h-3.5 w-3.5 fill-current" />
              </Button>
            ) : (
              <Button type="submit" variant="primary" disabled={!input.trim() || !repoId} aria-label="Send" className={clsx("rounded-xl", !input.trim() && "opacity-40")}>
                <ArrowUp className="h-4 w-4" />
              </Button>
            )}
          </div>
          <div className="mt-1.5 flex justify-between px-1 text-[10.5px] text-slate-600">
            <span>
              <kbd className="font-sans">Enter</kbd> to send · <kbd className="font-sans">Shift + Enter</kbd> for a new line
            </span>
            <span className="hidden sm:inline">Answers cite indexed code; verify before relying on them.</span>
          </div>
        </div>
      </form>
    </div>
  );
}
