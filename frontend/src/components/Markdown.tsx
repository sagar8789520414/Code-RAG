import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SourceRef } from "../lib/types";
import { CodeViewer } from "./CodeViewer";

/**
 * Turns `[3]` / `[1, 4]` citation markers into `#cite-n` links, leaving fenced and
 * inline code untouched, so the link renderer can swap them for clickable chips.
 */
function linkCitations(md: string, max: number): string {
  return md
    .split(/(```[\s\S]*?(?:```|$))/g)
    .map((block, i) =>
      i % 2 === 1
        ? block
        : block
            .split(/(`[^`\n]*`)/g)
            .map((seg, j) =>
              j % 2 === 1
                ? seg
                : seg.replace(/\[(\d+(?:\s*,\s*\d+)*)\](?!\()/g, (m, nums: string) => {
                    const ns = nums.split(/\s*,\s*/).map(Number);
                    if (ns.some((n) => n < 1 || n > max)) return m;
                    return ns.map((n) => `[${n}](#cite-${n})`).join("");
                  }),
            )
            .join(""),
    )
    .join("");
}

interface Props {
  content: string;
  sources?: SourceRef[];
  onCite?: (s: SourceRef) => void;
}

export const Markdown = memo(function Markdown({ content, sources = [], onCite }: Props) {
  const components: Components = {
    a({ href, children }) {
      const m = href?.match(/^#cite-(\d+)$/);
      if (m) {
        const src = sources[Number(m[1]) - 1];
        return (
          <button
            type="button"
            onClick={() => src && onCite?.(src)}
            title={src ? `${src.path}:${src.startLine}-${src.endLine} · ${src.symbolPath}` : undefined}
            className="mx-0.5 inline-flex h-[18px] min-w-[18px] -translate-y-px items-center justify-center rounded bg-sky-500/15 px-1 align-middle font-mono text-[10.5px] font-semibold text-sky-300 ring-1 ring-sky-500/30 hover:bg-sky-500/30"
          >
            {children}
          </button>
        );
      }
      return (
        <a href={href} target="_blank" rel="noreferrer" className="text-sky-300 underline-offset-2 hover:underline">
          {children}
        </a>
      );
    },
    code({ className, children }) {
      const lang = /language-(\w+)/.exec(className ?? "")?.[1];
      const text = String(children);
      if (!lang && !text.includes("\n")) {
        return <code className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[0.85em] text-amber-200">{children}</code>;
      }
      return <CodeViewer code={text} language={lang ?? "plaintext"} className="my-3" maxHeight="28rem" />;
    },
    pre({ children }) {
      return <>{children}</>;
    },
  };
  return (
    <div className="prose-chat">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {linkCitations(content, sources.length)}
      </ReactMarkdown>
    </div>
  );
});
