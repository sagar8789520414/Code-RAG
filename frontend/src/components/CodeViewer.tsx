import clsx from "clsx";
import { Highlight, themes } from "prism-react-renderer";
import { useEffect, useRef } from "react";
import { prismLanguage } from "../lib/format";

interface Props {
  code: string;
  language: string;
  /** 1-based first line number of `code` within its file. */
  firstLine?: number;
  highlight?: [number, number];
  /** Scroll the first highlighted line into view on mount/change. */
  scrollToHighlight?: boolean;
  className?: string;
  maxHeight?: string;
}

export function CodeViewer({ code, language, firstLine = 1, highlight, scrollToHighlight, className, maxHeight }: Props) {
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollToHighlight && anchor.current) anchor.current.scrollIntoView({ block: "center" });
  }, [scrollToHighlight, highlight?.[0], highlight?.[1], code]);

  return (
    <Highlight code={code.replace(/\n$/, "")} language={prismLanguage(language)} theme={themes.vsDark}>
      {({ tokens, getLineProps, getTokenProps }) => (
        <pre className={clsx("overflow-auto rounded-lg bg-[#16181d] py-2 font-mono text-[12.5px] leading-[1.55]", className)} style={maxHeight ? { maxHeight } : undefined}>
          {tokens.map((line, i) => {
            const n = firstLine + i;
            const lit = highlight && n >= highlight[0] && n <= highlight[1];
            const { className: lineClass, style, ...rest } = getLineProps({ line });
            return (
              <div
                key={i}
                ref={highlight && n === highlight[0] ? anchor : undefined}
                className={clsx(lineClass, "flex min-w-max pr-4", lit ? "bg-sky-500/15 shadow-[inset_3px_0_0_#38bdf8]" : "")}
                style={{ ...style, backgroundColor: undefined }}
                {...rest}
              >
                <span className={clsx("w-12 shrink-0 select-none pr-3 text-right tabular-nums", lit ? "text-sky-300" : "text-slate-600")}>{n}</span>
                <span>
                  {line.map((token, key) => (
                    <span key={key} {...getTokenProps({ token })} />
                  ))}
                </span>
              </div>
            );
          })}
        </pre>
      )}
    </Highlight>
  );
}
