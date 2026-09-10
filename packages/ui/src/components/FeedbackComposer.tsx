/**
 * Inline composer that appears under a clicked block.
 */

import { useEffect, useRef, useState } from "react";
import type { BlockInfo, FeedbackKind } from "@plan-presenter/protocol";
import { useSession } from "../state.tsx";

export interface ComposerTarget {
  block: BlockInfo;
  selection: string | null;
  targetId: string | null;
  top: number;
  left: number;
  width: number;
}

export const KIND_LABEL: Record<FeedbackKind, string> = {
  comment: "Comment",
  change: "Change this",
  question: "Question",
  request: "Follow-up",
  approve: "Approve",
  reject: "Reject",
  answer: "Answer",
  error: "Render error",
};

export const KIND_ICON: Record<FeedbackKind, string> = {
  comment: "💬",
  change: "✏️",
  question: "❓",
  request: "➕",
  approve: "👍",
  reject: "👎",
  answer: "🗳️",
  error: "⚠️",
};

const KINDS: FeedbackKind[] = ["comment", "change", "question", "request", "approve", "reject"];

export function FeedbackComposer({
  target,
  onClose,
}: {
  target: ComposerTarget;
  onClose: () => void;
}) {
  const { createFeedback, currentPageId } = useSession();
  const [kind, setKind] = useState<FeedbackKind>(target.selection ? "change" : "comment");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textRef.current?.focus();
  }, []);

  const submit = async () => {
    if (!currentPageId) return;
    if (!body.trim() && kind !== "approve" && kind !== "reject") {
      textRef.current?.focus();
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await createFeedback({
        kind,
        author: "human",
        body: body.trim(),
        anchor: {
          pageId: currentPageId,
          blockId: target.block.id,
          block: target.block,
          selection: target.selection,
          targetId: target.targetId,
        },
      });
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="pp-composer"
      style={{ top: target.top, left: target.left, width: target.width }}
      onClick={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
    >
      <div className="pp-composer-head">
        <span className="pp-muted">
          {target.block.type} · line {target.block.line.start}
          {target.block.line.end !== target.block.line.start ? `–${target.block.line.end}` : ""}
        </span>
        <button type="button" className="pp-icon-button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {target.selection && (
        <blockquote className="pp-composer-quote">{target.selection}</blockquote>
      )}
      <div className="pp-kinds" role="radiogroup">
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            className={`pp-chip pp-chip-${k}${kind === k ? " pp-chip-active" : ""}`}
            onClick={() => setKind(k)}
          >
            <span aria-hidden="true">{KIND_ICON[k]}</span> {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <textarea
        ref={textRef}
        rows={3}
        value={body}
        placeholder={
          kind === "approve"
            ? "Optional note"
            : kind === "request"
              ? "What should the agent do next?"
              : "Say what you think…"
        }
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
        }}
      />
      {err && (
        <div className="pp-status-err" role="alert">
          Not saved: {err}. Your text is kept; try again.
        </div>
      )}
      <div className="pp-row pp-composer-actions">
        <button
          type="button"
          className="pp-button pp-button-primary"
          disabled={busy}
          onClick={submit}
        >
          Add {KIND_LABEL[kind].toLowerCase()}
        </button>
        <span className="pp-muted pp-kbd-hint">Ctrl+Enter</span>
        <span className="pp-spacer" />
        <button type="button" className="pp-link-button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
