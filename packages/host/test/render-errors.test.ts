import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Feedback, RenderErrorData } from "@plan-presenter/protocol";
import { SessionStore } from "../src/store.ts";

let root: string;
let store: SessionStore;
let events: Array<{ id: string; created: boolean }>;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "pp-err-"));
  store = new SessionStore(root);
  await store.init();
  events = [];
  store.onRenderError = (item: Feedback, created: boolean) => events.push({ id: item.id, created });
  await store.createSession({ id: "s", title: "T", allowedRoots: [], meta: {} });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const base = {
  pageId: "p",
  blockId: "code-1",
  block: null,
  targetId: null,
  source: "mermaid" as const,
  message: "Parse error on line 2",
  detail: "graph TD; A-->",
};

describe("render errors", () => {
  test("report creates a system item once, repeats bump the count silently", async () => {
    const a = await store.reportRenderError("s", base);
    expect(a.created).toBe(true);
    expect(a.item.author).toBe("system");
    expect(a.item.kind).toBe("error");
    expect(a.item.anchor.blockId).toBe("code-1");
    expect((a.item.data as RenderErrorData).count).toBe(1);

    const b = await store.reportRenderError("s", base);
    expect(b.created).toBe(false);
    expect(b.reopened).toBe(false);
    expect(b.item.id).toBe(a.item.id);
    expect((b.item.data as RenderErrorData).count).toBe(2);
    expect(events).toEqual([{ id: a.item.id, created: true }]);

    // A different message on the same block is a separate item.
    const c = await store.reportRenderError("s", { ...base, message: "other" });
    expect(c.created).toBe(true);
    expect((await store.listFeedback("s", { kind: "error" })).length).toBe(2);
  });

  test("resolve on page change, reopen on repeat", async () => {
    const a = await store.reportRenderError("s", base);
    expect(await store.resolveRenderErrors("s", "p")).toBe(1);
    expect((await store.listFeedback("s", { kind: "error", status: "open" })).length).toBe(0);
    const again = await store.reportRenderError("s", base);
    expect(again.reopened).toBe(true);
    expect(again.item.id).toBe(a.item.id);
    expect(again.item.status).toBe("open");
    expect(events.map((e) => e.created)).toEqual([true, false]);
  });

  test("resolve can be limited to sources", async () => {
    await store.reportRenderError("s", base);
    await store.reportRenderError("s", { ...base, source: "compile", blockId: null, message: "x" });
    expect(await store.resolveRenderErrors("s", "p", ["compile"])).toBe(1);
    const open = await store.listFeedback("s", { kind: "error", status: "open" });
    expect(open.map((f) => (f.data as RenderErrorData).source)).toEqual(["mermaid"]);
  });

  test("compile errors are reported from getPage and cleared when fixed", async () => {
    await store.writePage("s", "bad", "# ok\n\n<Unclosed\n");
    const page = await store.getPage("s", "bad");
    expect(page.error).toBeTruthy();
    const open = await store.listFeedback("s", { kind: "error", status: "open" });
    expect(open.length).toBe(1);
    expect((open[0]!.data as RenderErrorData).source).toBe("compile");
    expect(open[0]!.anchor.pageId).toBe("bad");

    await store.writePage("s", "bad", "# ok now\n");
    await store.getPage("s", "bad");
    expect((await store.listFeedback("s", { kind: "error", status: "open" })).length).toBe(0);
  });

  test("system items never join a human batch", async () => {
    await store.reportRenderError("s", base);
    const anchor = { pageId: "p", blockId: "p-1", block: null, selection: null, targetId: null };
    await store.createFeedback("s", { kind: "comment", anchor, body: "hi", author: "human" });
    const sent = await store.sendBatch("s");
    expect(sent.items.length).toBe(1);
    expect(sent.items[0]!.kind).toBe("comment");
    const errs = await store.listFeedback("s", { kind: "error" });
    expect(errs[0]!.batch).toBeNull();
  });
});
