/**
 * Full session layout: header, page nav, page, feedback sidebar. This is the
 * component an embedder mounts (via <PlanPresenter>) to show one session.
 */

import { useEffect, useState } from "react";
import type { Feedback, SessionStatus } from "@plan-presenter/protocol";
import { useSession } from "../state.tsx";
import { FeedbackSidebar } from "./FeedbackSidebar.tsx";
import { PageView } from "./PageView.tsx";

const STATUS_LABEL: Record<SessionStatus, string> = {
  drafting: "Agent is drafting",
  "awaiting-review": "Ready for your review",
  reviewed: "Feedback sent",
  closed: "Closed",
};

export interface SessionViewProps {
  onBack?: () => void;
}

export function SessionView({ onBack }: SessionViewProps) {
  const { session, connected, loading, error, currentPageId, setCurrentPage, feedback } = useSession();
  const [focused, setFocused] = useState<Feedback | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 900);

  // Clear focus when the page changes underneath.
  useEffect(() => {
    if (focused && focused.anchor.pageId !== currentPageId) setFocused(null);
  }, [currentPageId, focused]);

  const openCount = feedback.filter((f) => f.status !== "resolved" && f.kind !== "answer").length;

  if (loading) return <div className="pp-empty">Loading…</div>;
  if (!session) return <div className="pp-empty">{error ?? "Session not found."}</div>;

  return (
    <div className={`pp-shell${sidebarOpen ? " pp-shell-sidebar" : ""}`}>
      <header className="pp-header">
        {onBack && (
          <button type="button" className="pp-icon-button" onClick={onBack} aria-label="All sessions">
            ←
          </button>
        )}
        <h1 className="pp-title">{session.title}</h1>
        <span className={`pp-pill pp-pill-${session.status}`}>{STATUS_LABEL[session.status]}</span>
        <span className="pp-spacer" />
        <span className={`pp-pill ${connected ? "pp-pill-ok" : "pp-pill-warn"}`}>{connected ? "live" : "reconnecting…"}</span>
        <button type="button" className="pp-button" onClick={() => setSidebarOpen((s) => !s)} aria-pressed={sidebarOpen}>
          Feedback {openCount > 0 && <span className="pp-count">{openCount}</span>}
        </button>
      </header>

      {session.status === "awaiting-review" && (
        <div className="pp-banner">The agent is waiting for your review. Click anything to comment, then press <strong>Send to agent</strong>.</div>
      )}
      {error && <div className="pp-banner pp-banner-err">{error}</div>}

      {session.pageSummaries.length > 1 && (
        <nav className="pp-pages" aria-label="Pages">
          {session.pageSummaries.map((p, i) => (
            <button
              key={p.id}
              type="button"
              className={`pp-page-tab${p.id === currentPageId ? " pp-page-tab-active" : ""}`}
              onClick={() => setCurrentPage(p.id)}
            >
              <span className="pp-muted">{i + 1}</span> {p.title}
              {p.openFeedback > 0 && <span className="pp-count">{p.openFeedback}</span>}
            </button>
          ))}
        </nav>
      )}

      <main className="pp-main">
        <PageView
          focusedBlockId={focused?.anchor.blockId ?? null}
          onFocusFeedback={(id) => {
            setFocused(feedback.find((f) => f.id === id) ?? null);
            setSidebarOpen(true);
          }}
        />
      </main>

      {sidebarOpen && <FeedbackSidebar focusedId={focused?.id ?? null} onFocus={setFocused} />}
    </div>
  );
}
