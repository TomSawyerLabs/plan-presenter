import { useEffect, useState } from "react";
import type { SessionSummary } from "@plan-presenter/protocol";
import type { Transport } from "../transport.ts";

export function SessionList({
  transport,
  onOpen,
}: {
  transport: Transport;
  onOpen: (id: string) => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      transport
        .listSessions()
        .then(setSessions)
        .catch((e) => setError((e as Error).message));
    load();
    const off = transport.subscribe((e) => {
      if (
        e.type === "session.changed" ||
        e.type === "session.removed" ||
        e.type === "feedback.changed" ||
        e.type === "feedback.batch"
      )
        load();
    });
    return off;
  }, [transport]);

  return (
    <div className="pp-shell">
      <header className="pp-header">
        <h1 className="pp-title">plan-presenter</h1>
        <span className="pp-spacer" />
        <span className="pp-muted pp-small">{sessions?.length ?? 0} sessions</span>
      </header>
      <main className="pp-main pp-list">
        {error && <div className="pp-banner pp-banner-err">{error}</div>}
        {sessions?.length === 0 && (
          <div className="pp-empty">
            No sessions yet. An agent creates one with <code>pp new "Title"</code>.
          </div>
        )}
        {sessions?.map((s) => (
          <button key={s.id} type="button" className="pp-session-card" onClick={() => onOpen(s.id)}>
            <div className="pp-row">
              <strong>{s.title}</strong>
              <span className={`pp-pill pp-pill-${s.status}`}>{s.status}</span>
              <span className="pp-spacer" />
              {s.openFeedback > 0 && <span className="pp-count">{s.openFeedback} open</span>}
            </div>
            <div className="pp-muted pp-small">
              {s.pageSummaries.length} page{s.pageSummaries.length === 1 ? "" : "s"} · updated{" "}
              {new Date(s.updatedAt).toLocaleString()} · <code>{s.id}</code>
            </div>
          </button>
        ))}
      </main>
    </div>
  );
}
