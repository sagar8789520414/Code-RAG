const KEY = "coderag.settings.v1";

export interface Settings {
  apiUrl: string;
  adminKey: string;
}

const defaults: Settings = {
  apiUrl: (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, "") ?? "",
  adminKey: "",
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { apiUrl: parsed.apiUrl ?? defaults.apiUrl, adminKey: parsed.adminKey ?? "" };
  } catch {
    return defaults;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // storage unavailable (private mode); settings stay in memory for this session
  }
}

export function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota / privacy-mode errors
  }
}
