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
          block: {
            id: "p-1",
            type: "paragraph",
            line: { start: 8, end: 10 },
            excerpt: "The current pipeline",
          },
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
        anchor: {
          pageId: "01-overview",
          blockId: null,
          block: null,
          selection: null,
          targetId: "queue",
        },
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

describe("formatFeedbackMarkdown render errors", () => {
  test("shows source, count and the failing snippet", () => {
    const items: Feedback[] = [
      {
        ...base,
        id: "err_1",
        kind: "error",
        author: "system",
        body: "Parse error on line 2",
        data: { source: "mermaid", detail: "graph TD; A-->", count: 3 },
        batch: null,
        anchor: {
          pageId: "01-overview",
          blockId: "code-1",
          block: {
            id: "code-1",
            type: "code",
            line: { start: 20, end: 24 },
            excerpt: "mermaid graph",
          },
          selection: null,
          targetId: null,
        },
      },
    ];
    const md = formatFeedbackMarkdown(session, items);
    expect(md).toContain("### RENDER ERROR · lines 20-24 (code) · id err_1");
    expect(md).toContain("Source: mermaid (seen 3x)");
    expect(md).toContain("> Parse error on line 2");
    expect(md).toContain("```\ngraph TD; A-->\n```");
  });
});

describe("formatFeedbackMarkdown reviewers", () => {
  const anchor = {
    pageId: "01-overview",
    blockId: "p-1",
    block: { id: "p-1", type: "paragraph", line: { start: 3, end: 3 }, excerpt: "Intro" },
    selection: null,
    targetId: null,
  };

  test("names the reviewer on each item and reply, and counts per reviewer", () => {
    const items: Feedback[] = [
      {
        ...base,
        id: "fb_1",
        kind: "change",
        body: "Tighten this.",
        reviewer: { id: "rv_1", name: "Chris" },
        anchor,
        replies: [
          { id: "r1", author: "agent", body: "Done", createdAt: base.createdAt },
          {
            id: "r2",
            author: "human",
            reviewer: { id: "rv_2", name: "Dana" },
            body: "Agreed",
            createdAt: base.createdAt,
          },
        ],
      },
      {
        ...base,
        id: "fb_2",
        kind: "comment",
        body: "Fine.",
        reviewer: { id: "rv_1", name: "Chris" },
        anchor,
      },
      { ...base, id: "fb_3", kind: "approve", body: "", reviewer: { id: "rv_3" }, anchor },
      { ...base, id: "fb_4", kind: "comment", body: "From the owner.", anchor },
    ];
    const md = formatFeedbackMarkdown(session, items);
    expect(md).toContain("By reviewer: Chris (2), unnamed reviewer rv_3 (1), owner (1)");
    expect(md).toContain("### CHANGE REQUESTED · lines 3 (paragraph) · id fb_1 — Reviewer: Chris");
    expect(md).toContain(
      "### APPROVED · lines 3 (paragraph) · id fb_3 — Reviewer: unnamed reviewer rv_3",
    );
    expect(md).toContain("### COMMENT · lines 3 (paragraph) · id fb_4\n");
    expect(md).toContain("- agent: Done");
    expect(md).toContain("- human (Dana): Agreed");
  });

  test("no reviewer line when nothing came through an invite", () => {
    const md = formatFeedbackMarkdown(session, [
      { ...base, id: "fb_1", kind: "comment", body: "x", anchor },
    ]);
    expect(md).not.toContain("By reviewer:");
  });
});
