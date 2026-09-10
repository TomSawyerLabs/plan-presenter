/**
 * Right-hand panel: every feedback item for the session, grouped by page,
 * with reply / resolve / delete, plus the "Send to agent" action.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Feedback } from "@plan-presenter/protocol";
import { useSession } from "../state.tsx";
import { KIND_ICON, KIND_LABEL } from "./FeedbackComposer.tsx";

export interface FeedbackSidebarProps {
  focusedId: string | null;
  onFocus: (f: Feedback | null) => void;
}

export function FeedbackSidebar({ focusedId, onFocus }: FeedbackSidebarProps) {
  const { session, feedback, pages, setCurrentPage, send } = useSession();
  const [filter, setFilter] = useState<"all" | "open" | "resolved">("all");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<number | null>(null);

  // System-reported render errors are for the agent, not the human.
  const human = useMemo(() => feedback.filter((f) => f.author !== "system"), [feedback]);
  const pending = human.filter((f) => f.batch === null);
  const visible = useMemo(
    () =>
      human
        .filter((f) =>
          filter === "all"
            ? true
            : filter === "open"
              ? f.status !== "resolved"
              : f.status === "resolved",
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [human, filter],
  );

  const byPage = useMemo(() => {
    const m = new Map<string, Feedback[]>();
    for (const f of visible) m.set(f.anchor.pageId, [...(m.get(f.anchor.pageId) ?? []), f]);
    return m;
  }, [visible]);

  const doSend = async () => {
    setSending(true);
    try {
      const r = await send();
      setSent(r.batch);
      setTimeout(() => setSent(null), 4000);
    } catch {
      /* shown by the session notice */
    } finally {
      setSending(false);
    }
  };

  const pageTitle = (id: string) => session?.pageSummaries.find((p) => p.id === id)?.title ?? id;

  return (
    <aside className="pp-sidebar">
      <div className="pp-sidebar-head">
        <strong>Feedback</strong>
        <span className="pp-muted">{human.length}</span>
        <span className="pp-spacer" />
        <div className="pp-seg" role="radiogroup">
          {(["all", "open", "resolved"] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={filter === f}
              className={filter === f ? "pp-seg-active" : ""}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="pp-send">
        <button
          type="button"
          className="pp-button pp-button-primary pp-button-wide"
          disabled={sending || pending.length === 0}
          onClick={doSend}
        >
          Send to agent {pending.length > 0 && <span className="pp-count">{pending.length}</span>}
        </button>
        {sent !== null && (
          <div className="pp-status-ok">Sent batch #{sent}. The agent will pick it up.</div>
        )}
        {pending.length === 0 && sent === null && (
          <div className="pp-muted pp-small">Click anything on the page to add feedback.</div>
        )}
      </div>

      <div className="pp-sidebar-list">
        {visible.length === 0 && <div className="pp-empty pp-small">Nothing here yet.</div>}
        {[...byPage.entries()].map(([pageId, items]) => (
          <section key={pageId} className="pp-fb-group">
            {byPage.size > 1 && (
              <h4 className="pp-fb-group-title">
                <button
                  type="button"
                  className="pp-link-button"
                  onClick={() => setCurrentPage(pageId)}
                >
                  {pageTitle(pageId)}
                </button>
              </h4>
            )}
            {items.map((f) => (
              <FeedbackCard
                key={f.id}
                item={f}
                focused={f.id === focusedId}
                orphaned={
                  f.anchor.blockId !== null &&
                  pages.get(pageId) !== undefined &&
                  !pages.get(pageId)!.blocks.some((b) => b.id === f.anchor.blockId)
                }
                onFocus={() => {
                  setCurrentPage(f.anchor.pageId);
                  onFocus(f);
                }}
              />
            ))}
          </section>
        ))}
      </div>
    </aside>
  );
}

function FeedbackCard({
  item,
  focused,
  orphaned,
  onFocus,
}: {
  item: Feedback;
  focused: boolean;
  orphaned: boolean;
  onFocus: () => void;
}) {
  const { updateFeedback, deleteFeedback, reply } = useSession();
  const [replyText, setReplyText] = useState("");
  const [replying, setReplying] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focused]);

  const resolved = item.status === "resolved";
  const sendReply = async () => {
    if (!replyText.trim()) return;
    try {
      await reply(item.id, replyText.trim());
    } catch {
      return; // the session notice shows the failure; keep the text so nothing is lost
    }
    setReplyText("");
    setReplying(false);
  };

  return (
    <div
      ref={ref}
      className={`pp-fb pp-fb-${item.kind}${focused ? " pp-fb-focused" : ""}${resolved ? " pp-fb-resolved" : ""}`}
    >
      <div
        className="pp-fb-head"
        onClick={onFocus}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && onFocus()}
      >
        <span className={`pp-chip pp-chip-${item.kind} pp-chip-small`}>
          <span aria-hidden="true">{KIND_ICON[item.kind]}</span> {KIND_LABEL[item.kind]}
        </span>
        <span className="pp-muted pp-small">
          {item.anchor.block
            ? `L${item.anchor.block.line.start}`
            : item.anchor.targetId
              ? `#${item.anchor.targetId}`
              : "page"}
        </span>
        {item.batch !== null && <span className="pp-muted pp-small">batch {item.batch}</span>}
        {item.status === "acknowledged" && <span className="pp-tag">agent replied</span>}
        {resolved && <span className="pp-tag pp-tag-ok">resolved</span>}
        {orphaned && <span className="pp-tag pp-tag-warn">block changed</span>}
      </div>
      {item.anchor.selection ? (
        <blockquote className="pp-fb-quote">{item.anchor.selection}</blockquote>
      ) : item.anchor.block ? (
        <div className="pp-fb-excerpt pp-muted">{item.anchor.block.excerpt}</div>
      ) : null}
      {item.body && <div className="pp-fb-body">{item.body}</div>}
      {item.replies.length > 0 && (
        <div className="pp-fb-replies">
          {item.replies.map((r) => (
            <div key={r.id} className={`pp-reply pp-reply-${r.author}`}>
              <span className="pp-reply-author">
                {r.author === "agent" ? "🤖 agent" : "🧑 you"}
              </span>{" "}
              {r.body}
            </div>
          ))}
        </div>
      )}
      <div className="pp-fb-actions pp-row">
        {replying ? (
          <>
            <input
              className="pp-input"
              value={replyText}
              placeholder="Reply…"
              autoFocus
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void sendReply();
                if (e.key === "Escape") setReplying(false);
              }}
            />
            <button type="button" className="pp-button" onClick={sendReply}>
              Send
            </button>
          </>
        ) : (
          <>
            <button type="button" className="pp-link-button" onClick={() => setReplying(true)}>
              Reply
            </button>
            <button
              type="button"
              className="pp-link-button"
              onClick={() =>
                updateFeedback(item.id, { status: resolved ? "open" : "resolved" }).catch(() => {})
              }
            >
              {resolved ? "Reopen" : "Resolve"}
            </button>
            {item.batch === null && (
              <button
                type="button"
                className="pp-link-button pp-danger"
                onClick={() => deleteFeedback(item.id).catch(() => {})}
              >
                Delete
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
