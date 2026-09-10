/**
 * <Question id="db" options={["Postgres", "SQLite"]}>Which store?</Question>
 *
 * An inline prompt from the agent to the human. The answer is stored as
 * feedback of kind `answer` with `anchor.targetId = id`, so `pp feedback`
 * returns it alongside everything else. Supports single/multiple choice and
 * an optional free-text field.
 */

import { useMemo, useState, type ReactNode } from "react";
import { useSessionOptional } from "../../state.tsx";

export interface QuestionProps {
  id: string;
  options?: string[];
  multiple?: boolean;
  /** Show a free-text field (default: true when there are no options). */
  text?: boolean;
  placeholder?: string;
  children?: ReactNode;
  [attr: `data-${string}`]: string | undefined;
}

interface AnswerData {
  selected: string[];
  text: string;
}

export function Question(props: QuestionProps) {
  const {
    id,
    options = [],
    multiple = false,
    text = options.length === 0,
    placeholder,
    children,
  } = props;
  const session = useSessionOptional();
  const dataAttrs = Object.fromEntries(
    Object.entries(props).filter(([k]) => k.startsWith("data-")),
  );

  const existing = useMemo(
    () =>
      session?.feedback
        .filter((f) => f.kind === "answer" && f.anchor.targetId === id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null,
    [session?.feedback, id],
  );
  const existingData = (existing?.data as AnswerData | undefined) ?? null;

  const [selected, setSelected] = useState<string[]>(existingData?.selected ?? []);
  const [free, setFree] = useState(existingData?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [editing, setEditing] = useState(!existing);

  const toggle = (opt: string) => {
    setSelected((prev) =>
      multiple ? (prev.includes(opt) ? prev.filter((o) => o !== opt) : [...prev, opt]) : [opt],
    );
  };

  const submit = async () => {
    if (!session || !session.currentPageId) return;
    setBusy(true);
    try {
      const data: AnswerData = { selected, text: free };
      const body = [selected.length ? selected.join(", ") : null, free.trim() || null]
        .filter(Boolean)
        .join(" - ");
      if (existing && existing.batch === null) {
        await session.updateFeedback(existing.id, { body });
        // data isn't patchable through UpdateFeedback; recreate for a clean record
        await session.deleteFeedback(existing.id);
      }
      await session.createFeedback({
        kind: "answer",
        author: "human",
        body,
        data,
        anchor: {
          pageId: session.currentPageId,
          blockId: (props["data-pp-block"] as string | undefined) ?? null,
          block: null,
          selection: null,
          targetId: id,
        },
      });
      setSaved(true);
      setEditing(false);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      /* shown by the session notice; the answer stays in the form */
    } finally {
      setBusy(false);
    }
  };

  const answered = existing && !editing;

  return (
    <div
      className={`pp-question${answered ? " pp-question-answered" : ""}`}
      data-pp-interactive=""
      data-pp-target={id}
      {...dataAttrs}
    >
      <div className="pp-question-prompt">
        <span className="pp-question-badge">Question</span> {children}
      </div>
      {answered ? (
        <div className="pp-question-answer">
          <span className="pp-muted">Answered: </span>
          <strong>{existing.body || "(no text)"}</strong>{" "}
          <button type="button" className="pp-link-button" onClick={() => setEditing(true)}>
            Change
          </button>
        </div>
      ) : (
        <>
          {options.length > 0 && (
            <div className="pp-question-options">
              {options.map((opt) => (
                <label key={opt} className="pp-option">
                  <input
                    type={multiple ? "checkbox" : "radio"}
                    name={`pp-q-${id}`}
                    checked={selected.includes(opt)}
                    onChange={() => toggle(opt)}
                  />
                  <span>{opt}</span>
                </label>
              ))}
            </div>
          )}
          {text && (
            <textarea
              className="pp-question-text"
              rows={2}
              placeholder={placeholder ?? "Your answer"}
              value={free}
              onChange={(e) => setFree(e.target.value)}
            />
          )}
          <div className="pp-row">
            <button
              type="button"
              className="pp-button pp-button-primary"
              disabled={busy || (!selected.length && !free.trim())}
              onClick={submit}
            >
              {existing ? "Update answer" : "Answer"}
            </button>
            {existing && (
              <button type="button" className="pp-link-button" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
            {saved && <span className="pp-status-ok">Saved</span>}
          </div>
        </>
      )}
    </div>
  );
}
