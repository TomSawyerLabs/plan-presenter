/**
 * What the human sees when something on the page could not be rendered. The
 * detailed error goes to the agent as system feedback; here we only say what
 * kind of thing failed and that the agent already knows.
 */

import { useEffect, useRef } from "react";
import type { RenderErrorSource } from "@plan-presenter/protocol";
import { useSessionOptional } from "../state.tsx";

export interface RenderProblemProps {
  /** Human noun: "diagram", "chart", "image", "page". */
  what: string;
  source: RenderErrorSource;
  message: string;
  detail?: string | null;
  blockId?: string | null;
  targetId?: string | null;
  /** Render inline (span) instead of as a block. */
  inline?: boolean;
  /** Only show the placeholder; the host already reported this error. */
  silent?: boolean;
}

export function RenderProblem({
  what,
  source,
  message,
  detail = null,
  blockId = null,
  targetId = null,
  inline = false,
  silent = false,
}: RenderProblemProps) {
  const session = useSessionOptional();
  const report = session?.reportError;
  const pageId = session?.currentPageId ?? null;
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (silent || !report || !pageId) return;
    // Fall back to the enclosing block in the DOM so every placeholder is located.
    const resolvedBlock = blockId ?? blockIdOf(ref.current);
    report({ pageId, blockId: resolvedBlock, block: null, targetId, source, message, detail });
  }, [silent, report, pageId, blockId, targetId, source, message, detail]);

  const className = `pp-render-problem${inline ? " pp-render-problem-inline" : ""}`;
  const body = (
    <>
      <span aria-hidden="true">⚠️</span> Couldn’t render this {what}. The agent has been notified.
    </>
  );
  return inline ? (
    <span ref={ref as React.RefObject<HTMLSpanElement>} className={className} role="status">
      {body}
    </span>
  ) : (
    <div ref={ref as React.RefObject<HTMLDivElement>} className={className} role="status">
      {body}
    </div>
  );
}

/** Find the enclosing block id for an element (for inline media inside paragraphs). */
export function blockIdOf(el: Element | null): string | null {
  return el?.closest("[data-pp-block]")?.getAttribute("data-pp-block") ?? null;
}
