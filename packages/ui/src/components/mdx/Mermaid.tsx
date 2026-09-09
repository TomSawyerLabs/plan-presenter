/**
 * <Mermaid> - renders a Mermaid diagram. Also used automatically for
 * ```mermaid fenced code blocks. Mermaid is loaded lazily on first use.
 */

import { useEffect, useId, useState } from "react";
import { isDarkMode } from "./palette.ts";

export interface MermaidProps {
  chart?: string;
  children?: string;
  id?: string;
  [attr: `data-${string}`]: string | undefined;
}

let mermaidPromise: Promise<(typeof import("mermaid"))["default"]> | null = null;
function loadMermaid() {
  mermaidPromise ??= import("mermaid").then((m) => m.default);
  return mermaidPromise;
}

let renderSeq = 0;

export function Mermaid(props: MermaidProps) {
  const source = (props.chart ?? (typeof props.children === "string" ? props.children : "")).trim();
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [dark, setDark] = useState(isDarkMode);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setDark(isDarkMode());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!source) return;
    loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          theme: dark ? "dark" : "default",
          securityLevel: "strict",
          fontFamily: "inherit",
        });
        const { svg } = await mermaid.render(`pp-mmd-${reactId}-${++renderSeq}`, source);
        if (!cancelled) {
          setSvg(svg);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String((e as Error).message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [source, dark, reactId]);

  const dataAttrs = Object.fromEntries(
    Object.entries(props).filter(([k]) => k.startsWith("data-")),
  );
  return (
    <figure className="pp-mermaid" data-pp-target={props.id} {...dataAttrs}>
      {error ? (
        <pre className="pp-inline-error">
          Mermaid error: {error}
          {"\n\n"}
          {source}
        </pre>
      ) : svg ? (
        <div className="pp-mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="pp-muted">Rendering diagram…</div>
      )}
    </figure>
  );
}
