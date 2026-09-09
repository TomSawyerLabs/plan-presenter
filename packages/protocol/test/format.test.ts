import { describe, expect, test } from "bun:test";
import { formatFeedbackMarkdown, type Feedback, type SessionSummary } from "../src/index.ts";

const session: SessionSummary = {
  id: "s1",
  title: "Plan",
  status: "reviewed",
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  allowedRoots: [],
  pages: [],
  meta: {},
  dir: "C:\\sessions\\s1",
  pageSummaries: [{ id: "01-overview", title: "Overview", openFeedback: 1 }],
  openFeedback: 1,
};

const base = {
  sessionId: "s1",
  status: "open" as const,
  author: "human" as const,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  replies: [],
  batch: 1,
};

describe("formatFeedbackMarkdown", () => {
  test("renders items grouped by page with lines, excerpt, selection and replies", () => {
    const items: Feedback[] = [
      {
        ...base,
        id: "fb_1",
        kind: "change",
        body: "Be specific.",
        anchor: {
          pageId: "01-overview",
          blockId: "p-1",
          block: { id: "p-1", type: "paragraph", line: { start: 8, end: 10 }, excerpt: "The current pipeline" },
          selection: "spikes cascade",
          targetId: null,
        },
        replies: [{ id: "r1", author: "agent", body: "Done", createdAt: base.createdAt }],
      },
      {
        ...base,
        id: "fb_2",
        kind: "answer",
        body: "NATS",
        data: { selected: ["NATS"], text: "" },
        anchor: { pageId: "01-overview", blockId: null, block: null, selection: null, targetId: "queue" },
      },
    ];
    const md = formatFeedbackMarkdown(session, items, { sessionDir: session.dir });
    expect(md).toContain('## Page "Overview" (C:\\sessions\\s1\\pages\\01-overview.mdx)');
    expect(md).toContain("### CHANGE REQUESTED · lines 8-10 (paragraph) · id fb_1");
    expect(md).toContain('Block: "The current pipeline"');
    expect(md).toContain('Selected text: "spikes cascade"');
    expect(md).toContain("> Be specific.");
    expect(md).toContain("- agent: Done");
    expect(md).toContain("### ANSWER · target #queue · id fb_2");
    expect(md).toContain("Selected: NATS");
  });

  test("empty", () => {
    expect(formatFeedbackMarkdown(session, [])).toContain("_No feedback items._");
  });
});
