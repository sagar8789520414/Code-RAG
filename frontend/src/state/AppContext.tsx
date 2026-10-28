import { useQuery } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import { api, setApiSettings } from "../lib/api";
import { loadSettings, readLocal, saveSettings, writeLocal, type Settings } from "../lib/settings";
import type { Repo } from "../lib/types";
import { chatReducer, type ChatAction, type ChatState } from "./chatReducer";

export interface PreviewTarget {
  repoId: string;
  path: string;
  startLine?: number;
  endLine?: number;
}

interface AppState {
  settings: Settings;
  updateSettings: (s: Settings) => void;
  repos: Repo[];
  reposLoading: boolean;
  reposError: Error | null;
  repoId: string | undefined;
  repo: Repo | undefined;
  selectRepo: (id: string) => void;
  preview: PreviewTarget | null;
  openPreview: (t: PreviewTarget) => void;
  closePreview: () => void;
  chats: ChatState;
  dispatchChat: (a: ChatAction) => void;
}

const Ctx = createContext<AppState | null>(null);
const REPO_KEY = "coderag.repo";
const CHAT_KEY = "coderag.chats.v1";

export function AppProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState(loadSettings);
  const [repoId, setRepoId] = useState<string | undefined>(() => readLocal<string | undefined>(REPO_KEY, undefined));
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const [chats, dispatchChat] = useReducer(chatReducer, undefined, () => readLocal<ChatState>(CHAT_KEY, {}));

  const reposQuery = useQuery({
    queryKey: ["repos", settings.apiUrl],
    queryFn: api.repos,
    // Poll faster while anything is indexing so progress feels live.
    refetchInterval: (q) => ((q.state.data ?? []).some((r) => r.activeJob || r.status === "indexing") ? 2000 : 15_000),
  });
  const repos = useMemo(() => reposQuery.data ?? [], [reposQuery.data]);

  useEffect(() => {
    if (!repos.length) return;
    if (!repoId || !repos.some((r) => r._id === repoId)) {
      const preferred = repos.find((r) => r.status === "ready") ?? repos[0];
      if (preferred) setRepoId(preferred._id);
    }
  }, [repos, repoId]);

  useEffect(() => writeLocal(REPO_KEY, repoId), [repoId]);
  useEffect(() => {
    // Persist finished conversations only; in-flight streams would restore as stuck.
    const settled = Object.fromEntries(Object.entries(chats).map(([k, msgs]) => [k, msgs.filter((m) => m.status !== "streaming").slice(-40)]));
    writeLocal(CHAT_KEY, settled);
  }, [chats]);

  const updateSettings = useCallback((s: Settings) => {
    const clean = { apiUrl: s.apiUrl.trim().replace(/\/+$/, ""), adminKey: s.adminKey.trim() };
    saveSettings(clean);
    setApiSettings(clean);
    setSettings(clean);
  }, []);

  const value: AppState = {
    settings,
    updateSettings,
    repos,
    reposLoading: reposQuery.isLoading,
    reposError: reposQuery.error,
    repoId,
    repo: repos.find((r) => r._id === repoId),
    selectRepo: setRepoId,
    preview,
    openPreview: setPreview,
    closePreview: () => setPreview(null),
    chats,
    dispatchChat,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}
