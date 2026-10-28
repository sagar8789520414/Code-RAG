import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useApp } from "../state/AppContext";
import { Button, Field, inputClass } from "./ui";

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { settings, updateSettings } = useApp();
  const qc = useQueryClient();
  const [apiUrl, setApiUrl] = useState(settings.apiUrl);
  const [adminKey, setAdminKey] = useState(settings.adminKey);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4" onClick={onClose}>
      <form
        className="w-full max-w-md space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          updateSettings({ apiUrl, adminKey });
          void qc.invalidateQueries();
          onClose();
        }}
      >
        <h2 className="text-base font-semibold">Settings</h2>
        <Field label="API base URL" hint="Leave empty to use this site's origin (dev proxy). Example: https://code-rag-api.onrender.com">
          <input className={inputClass} value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://…" />
        </Field>
        <Field label="Admin API key" hint="Required for indexing, sync, delete and benchmarks when the server sets ADMIN_API_KEY. Stored only in this browser.">
          <input className={inputClass} type="password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} autoComplete="off" />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </div>
      </form>
    </div>
  );
}
