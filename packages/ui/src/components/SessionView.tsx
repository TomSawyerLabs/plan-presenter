/**
 * Full session layout: header, page nav, page, feedback sidebar. This is the
 * component an embedder mounts (via <PlanPresenter>) to show one session.
 */

import { useState } from "react";
import type { Feedback, ReviewerRef, SessionStatus } from "@plan-presenter/protocol";
import { useSession } from "../state.tsx";
import { FeedbackSidebar } from "./FeedbackSidebar.tsx";
import { PageView } from "./PageView.tsx";
import { ReviewerNamePrompt } from "./ReviewerNamePrompt.tsx";

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
  const {
    session,
    connected,
    loading,
    error,
    currentPageId,
    setCurrentPage,
    feedback,
    notice,
    dismissNotice,
    reviewer,
  } = useSession();
  const [focusedRaw, setFocused] = useState<Feedback | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 900);
  const [renaming, setRenaming] = useState(false);
  // An invited reviewer with no name yet is asked before anything else.
  const askName = reviewer !== null && (renaming || !reviewer.name);

  // Focus only applies while its page is the current one.
  const focused = focusedRaw && focusedRaw.anchor.pageId === currentPageId ? focusedRaw : null;

  const openCount = feedback.filter(
    (f) => f.status !== "resolved" && f.kind !== "answer" && f.author !== "system",
  ).length;
  const renderErrors = feedback.filter((f) => f.author === "system" && f.status !== "resolved");

  if (loading) return <div className="pp-empty">Loading…</div>;
  if (!session) return <div className="pp-empty">{error ?? "Session not found."}</div>;

  return (
    <div className={`pp-shell${sidebarOpen ? " pp-shell-sidebar" : ""}`}>
      <header className="pp-header">
        {onBack && (
          <button
            type="button"
            className="pp-icon-button"
            onClick={onBack}
            aria-label="All sessions"
          >
            ←
          </button>
        )}
        <h1 className="pp-title">{session.title}</h1>
        <span className={`pp-pill pp-pill-${session.status}`}>{STATUS_LABEL[session.status]}</span>
        {reviewer && (
          <button
            type="button"
            className="pp-pill pp-pill-reviewer"
            onClick={() => setRenaming(true)}
          >
            Reviewing as {reviewerName(reviewer)} · change
          </button>
        )}
        <span className="pp-spacer" />
        <span className={`pp-pill ${connected ? "pp-pill-ok" : "pp-pill-warn"}`}>
          {connected ? "live" : "reconnecting…"}
        </span>
        <button
          type="button"
          className="pp-button"
          onClick={() => setSidebarOpen((s) => !s)}
          aria-pressed={sidebarOpen}
        >
          Feedback {openCount > 0 && <span className="pp-count">{openCount}</span>}
        </button>
      </header>

      {session.status === "awaiting-review" && (
        <div className="pp-banner">
          The agent is waiting for your review. Click anything to comment, then press{" "}
          <strong>Send to agent</strong>.
        </div>
      )}
      {!connected && (
        <div className="pp-banner pp-banner-err" role="alert">
          <strong>Lost the connection to the host.</strong> Nothing you enter now is saved until it
          comes back; feedback you already added is safe. Retrying…
        </div>
      )}
      {notice && (
        <div className="pp-banner pp-banner-err" role="alert">
          <strong>{notice}</strong> Your text is still in the box; try again once the host is back.
          <button type="button" className="pp-link-button" onClick={dismissNotice}>
            Dismiss
          </button>
        </div>
      )}
      {error && <div className="pp-banner pp-banner-err">{error}</div>}
      {renderErrors.length > 0 && (
        <div className="pp-banner pp-banner-warn" role="status">
          {renderErrors.length === 1
            ? "One part of this session couldn’t render."
            : `${renderErrors.length} parts of this session couldn’t render.`}{" "}
          The agent has been notified and will fix it; the page updates live.
        </div>
      )}

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
      {askName && reviewer && (
        <ReviewerNamePrompt
          reviewer={reviewer}
          onDone={() => setRenaming(false)}
          cancellable={!!reviewer.name}
        />
      )}
    </div>
  );
}

export function reviewerName(r: ReviewerRef): string {
  return r.name?.trim() || "unnamed reviewer";
}
