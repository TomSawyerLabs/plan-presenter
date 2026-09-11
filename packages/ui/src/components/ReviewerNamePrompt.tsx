/**
 * Modal asking an invited reviewer for a display name. Shown on first visit
 * when the agent minted the invite without a name, and again on "change".
 */

import { useEffect, useRef, useState } from "react";
import type { ReviewerPublic } from "@plan-presenter/protocol";
import { useSession } from "../state.tsx";

export function ReviewerNamePrompt({
  reviewer,
  onDone,
  cancellable,
}: {
  reviewer: ReviewerPublic;
  onDone: () => void;
  cancellable: boolean;
}) {
  const { setReviewerName } = useSession();
  const [name, setName] = useState(reviewer.name ?? "");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const save = async () => {
    const clean = name.trim();
    if (!clean) {
      ref.current?.focus();
      return;
    }
    setBusy(true);
    try {
      await setReviewerName(clean);
      onDone();
    } catch {
      /* the session notice shows the failure; keep the text */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pp-veil" role="dialog" aria-modal="true" aria-labelledby="pp-name-title">
      <div className="pp-modal">
        <h2 id="pp-name-title" className="pp-modal-title">
          Who is reviewing?
        </h2>
        <p className="pp-muted pp-small">
          Your name is attached to every comment you leave, so the author knows who said what. You
          can only change or delete your own comments.
        </p>
        <input
          ref={ref}
          className="pp-input pp-input-wide"
          value={name}
          maxLength={80}
          placeholder="Your name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape" && cancellable) onDone();
          }}
        />
        <div className="pp-row pp-modal-actions">
          <button
            type="button"
            className="pp-button pp-button-primary"
            disabled={busy}
            onClick={save}
          >
            {reviewer.name ? "Save" : "Start reviewing"}
          </button>
          <span className="pp-muted pp-kbd-hint">Enter</span>
          <span className="pp-spacer" />
          {cancellable && (
            <button type="button" className="pp-link-button" onClick={onDone}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
