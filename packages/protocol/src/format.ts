/**
 * Canonical "feedback -> text for an agent" formatter. Used by the host
 * (`?format=md`) and therefore by the `pp` CLI, and intended for any native
 * integration that injects feedback into an agent thread.
 */

import type { Feedback, SessionSummary } from "./schemas.ts";

export interface FormatOptions {
  /** Session dir, so page paths are absolute and clickable in agent logs. */
  sessionDir?: string;
  heading?: string;
}

const KIND_VERB: Record<Feedback["kind"], string> = {
  comment: "COMMENT",
  change: "CHANGE REQUESTED",
  question: "QUESTION",
  request: "FOLLOW-UP REQUEST",
  approve: "APPROVED",
  reject: "REJECTED",
  answer: "ANSWER",
};

export function formatFeedbackMarkdown(
  session: SessionSummary,
  items: Feedback[],
  opts: FormatOptions = {},
): string {
  const lines: string[] = [];
  const heading = opts.heading ?? `Feedback for "${session.title}" (session ${session.id})`;
  lines.push(`# ${heading}`, "");
  if (items.length === 0) {
    lines.push("_No feedback items._", "");
    return lines.join("\n");
  }
  const counts = countBy(items, (f) => f.kind);
  lines.push(
    Object.entries(counts)
      .map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`)
      .join(", "),
    "",
  );

  const byPage = new Map<string, Feedback[]>();
  for (const f of items) byPage.set(f.anchor.pageId, [...(byPage.get(f.anchor.pageId) ?? []), f]);

  for (const [pageId, list] of byPage) {
    const title = session.pageSummaries.find((p) => p.id === pageId)?.title ?? pageId;
    const rel = `pages/${pageId}.mdx`;
    const path = opts.sessionDir ? joinPath(opts.sessionDir, rel) : rel;
    lines.push(`## Page "${title}" (${path})`, "");
    for (const f of list.sort(
      (a, b) => (a.anchor.block?.line.start ?? Infinity) - (b.anchor.block?.line.start ?? Infinity),
    )) {
      const where = f.anchor.block
        ? `lines ${f.anchor.block.line.start}${f.anchor.block.line.end !== f.anchor.block.line.start ? `-${f.anchor.block.line.end}` : ""} (${f.anchor.block.type})`
        : f.anchor.targetId
          ? `target #${f.anchor.targetId}`
          : "whole page";
      const status = f.status !== "open" ? ` [${f.status}]` : "";
      lines.push(`### ${KIND_VERB[f.kind]} · ${where} · id ${f.id}${status}`);
      if (f.anchor.block?.excerpt) lines.push(`Block: "${f.anchor.block.excerpt}"`);
      if (f.anchor.selection) lines.push(`Selected text: "${f.anchor.selection}"`);
      if (f.kind === "answer" && f.data && typeof f.data === "object") {
        const d = f.data as { selected?: string[]; text?: string };
        if (d.selected?.length) lines.push(`Selected: ${d.selected.join(", ")}`);
        if (d.text) lines.push(`Text: ${d.text}`);
      } else if (f.body) {
        lines.push("", indent(f.body), "");
      } else {
        lines.push("");
      }
      for (const r of f.replies) lines.push(`- ${r.author}: ${r.body.replace(/\n/g, "\n  ")}`);
      lines.push("");
    }
  }
  lines.push(
    "---",
    'To respond: `pp reply <session> <id> "..."`, `pp resolve <session> <id>`; edit the .mdx files in place (the UI live-reloads); then `pp review <session>` and `pp wait <session>` for the next round.',
    "",
  );
  return lines.join("\n");
}

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return out;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

function joinPath(dir: string, rel: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + rel.split("/").join(sep);
}
