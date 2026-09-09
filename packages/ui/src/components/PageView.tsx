/**
 * Renders one compiled page and turns clicks into feedback anchors.
 *
 * - Clicking any block (nearest `[data-pp-block]` ancestor) opens the
 *   composer for that block. Interactive elements (links, buttons, inputs,
 *   `[data-pp-interactive]`) are left alone.
 * - Selecting text inside a block opens the composer with the selection
 *   quoted, so the human can point at a phrase, not just a paragraph.
 * - Blocks with feedback get a gutter marker; clicking it opens the sidebar
 *   thread.
 */

import { run } from "@mdx-js/mdx";
import { MDXProvider, useMDXComponents } from "@mdx-js/react";
import type { MDXContent } from "mdx/types";
import * as runtime from "react/jsx-runtime";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BLOCK_ATTR, type BlockInfo, type Feedback } from "@plan-presenter/protocol";
import { useSession } from "../state.tsx";
import { mdxComponents } from "./mdx/index.ts";
import { FeedbackComposer, type ComposerTarget } from "./FeedbackComposer.tsx";

interface Marker {
  blockId: string;
  top: number;
  items: Feedback[];
}

export interface PageViewProps {
  onFocusFeedback?: (feedbackId: string) => void;
  focusedBlockId?: string | null;
}

export function PageView({ onFocusFeedback, focusedBlockId }: PageViewProps) {
  const { page, feedback, currentPageId } = useSession();
  // Evaluated module, tagged with the page it came from so a stale one is
  // never rendered for a different page/hash.
  const [evaluated, setEvaluated] = useState<{ key: string; Content: MDXContent } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [target, setTarget] = useState<ComposerTarget | null>(null);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  // Evaluate compiled MDX whenever the page hash changes.
  useEffect(() => {
    if (!page) return;
    const key = `${page.id}:${page.hash}`;
    let cancelled = false;
    run(page.code, { ...runtime, useMDXComponents, baseUrl: import.meta.url })
      .then((mod) => {
        if (!cancelled) {
          setEvaluated({ key, Content: mod.default });
          setRunError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setRunError(String((e as Error).message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [page]);

  const Content =
    page && evaluated && evaluated.key === `${page.id}:${page.hash}` ? evaluated.Content : null;

  const blocksById = useMemo(() => new Map((page?.blocks ?? []).map((b) => [b.id, b])), [page]);
  const pageFeedback = useMemo(
    () => feedback.filter((f) => f.anchor.pageId === currentPageId && f.kind !== "answer"),
    [feedback, currentPageId],
  );

  // Gutter markers: position of every block that has feedback.
  const recomputeMarkers = useCallback(() => {
    const root = containerRef.current;
    if (!root) return;
    const rootTop = root.getBoundingClientRect().top;
    const byBlock = new Map<string, Feedback[]>();
    for (const f of pageFeedback) {
      if (!f.anchor.blockId) continue;
      byBlock.set(f.anchor.blockId, [...(byBlock.get(f.anchor.blockId) ?? []), f]);
    }
    const next: Marker[] = [];
    for (const [blockId, items] of byBlock) {
      const el = root.querySelector<HTMLElement>(`[${BLOCK_ATTR}="${CSS.escape(blockId)}"]`);
      if (!el) continue;
      next.push({ blockId, top: el.getBoundingClientRect().top - rootTop, items });
    }
    next.sort((a, b) => a.top - b.top);
    setMarkers(next);
  }, [pageFeedback]);

  useLayoutEffect(() => {
    recomputeMarkers();
    const root = containerRef.current;
    if (!root) return;
    const ro = new ResizeObserver(() => recomputeMarkers());
    ro.observe(root);
    return () => ro.disconnect();
  }, [recomputeMarkers, Content]);

  // Highlight blocks that have open feedback (CSS hook) and the focused block.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    for (const el of root.querySelectorAll<HTMLElement>(`[${BLOCK_ATTR}]`)) {
      el.classList.remove("pp-block-open", "pp-block-resolved", "pp-block-focus");
    }
    for (const f of pageFeedback) {
      if (!f.anchor.blockId) continue;
      const el = root.querySelector<HTMLElement>(
        `[${BLOCK_ATTR}="${CSS.escape(f.anchor.blockId)}"]`,
      );
      el?.classList.add(f.status === "resolved" ? "pp-block-resolved" : "pp-block-open");
    }
    if (focusedBlockId) {
      const el = root.querySelector<HTMLElement>(`[${BLOCK_ATTR}="${CSS.escape(focusedBlockId)}"]`);
      if (el) {
        el.classList.add("pp-block-focus");
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }, [pageFeedback, focusedBlockId, Content]);

  const blockFromElement = (el: HTMLElement): { el: HTMLElement; info: BlockInfo } | null => {
    const blockEl = el.closest<HTMLElement>(`[${BLOCK_ATTR}]`);
    if (!blockEl) return null;
    const id = blockEl.getAttribute(BLOCK_ATTR)!;
    const known = blocksById.get(id);
    const [s, e] = (blockEl.getAttribute("data-pp-line") ?? "0-0").split("-").map(Number);
    const info: BlockInfo = known ?? {
      id,
      type: blockEl.getAttribute("data-pp-type") ?? "unknown",
      line: { start: s ?? 0, end: e ?? s ?? 0 },
      excerpt: (blockEl.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
    };
    return { el: blockEl, info };
  };

  const openComposerFor = (blockEl: HTMLElement, info: BlockInfo, selection: string | null) => {
    const root = containerRef.current!;
    const r = blockEl.getBoundingClientRect();
    const rootR = root.getBoundingClientRect();
    const targetId =
      blockEl.querySelector<HTMLElement>("[data-pp-target]")?.dataset.ppTarget ??
      blockEl.dataset.ppTarget ??
      null;
    setTarget({
      block: info,
      selection,
      targetId,
      top: r.bottom - rootR.top + 6,
      left: Math.max(0, r.left - rootR.left),
      width: Math.min(r.width, 520),
    });
  };

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (
      el.closest(
        "a, button, input, textarea, select, label, summary, [data-pp-interactive], .pp-composer, .pp-marker",
      )
    )
      return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return; // handled by onMouseUp
    const found = blockFromElement(el);
    if (!found) return;
    openComposerFor(found.el, found.info, null);
  };

  const onMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (el.closest(".pp-composer, [data-pp-interactive], input, textarea")) return;
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (!sel || sel.isCollapsed || !text) return;
    const anchorNode =
      sel.anchorNode instanceof HTMLElement ? sel.anchorNode : sel.anchorNode?.parentElement;
    if (!anchorNode) return;
    const found = blockFromElement(anchorNode);
    if (!found) return;
    openComposerFor(found.el, found.info, text.slice(0, 500));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTarget(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!page) return <div className="pp-empty">No page selected.</div>;

  return (
    <div className="pp-page-wrap">
      <div className="pp-gutter" aria-hidden={markers.length === 0}>
        {markers.map((m) => (
          <button
            key={m.blockId}
            type="button"
            className={`pp-marker${m.items.every((i) => i.status === "resolved") ? " pp-marker-resolved" : ""}`}
            style={{ top: m.top }}
            onClick={() => onFocusFeedback?.(m.items[0]!.id)}
          >
            {m.items.length}
          </button>
        ))}
      </div>
      <div ref={containerRef} className="pp-page" onClick={onClick} onMouseUp={onMouseUp}>
        {page.error && <pre className="pp-compile-error">Compile error: {page.error}</pre>}
        {runError && <pre className="pp-compile-error">Runtime error: {runError}</pre>}
        {Content && (
          <MDXProvider components={mdxComponents}>
            <article className="pp-article">
              <Content />
            </article>
          </MDXProvider>
        )}
        {target && (
          <FeedbackComposer
            target={target}
            onClose={() => {
              setTarget(null);
              window.getSelection()?.removeAllRanges();
            }}
          />
        )}
      </div>
    </div>
  );
}
