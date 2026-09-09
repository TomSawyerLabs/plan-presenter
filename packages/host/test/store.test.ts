import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotFound, SessionStore } from "../src/store.ts";

let root: string;
let store: SessionStore;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "pp-store-"));
  store = new SessionStore(root);
  await store.init();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("SessionStore", () => {
  test("creates a session with layout and lists it", async () => {
    const m = await store.createSession({ title: "T", allowedRoots: [], meta: {} });
    expect(m.status).toBe("drafting");
    expect(existsSync(join(root, m.id, "session.json"))).toBe(true);
    expect(existsSync(join(root, m.id, "pages"))).toBe(true);
    expect(existsSync(join(root, m.id, "feedback.json"))).toBe(true);
    expect(await store.listSessionIds()).toEqual([m.id]);
  });

  test("pages: write, order, compile cache, delete", async () => {
    const m = await store.createSession({ id: "s1", title: "T", allowedRoots: [], meta: {} });
    await store.writePage(m.id, "b-second", "---\norder: 2\n---\n# B\n");
    await store.writePage(m.id, "a-first", "---\norder: 1\n---\n# A\n");
    await store.writePage(m.id, "zzz", "# Z (no order)\n");
    expect(await store.listPageIds(m.id)).toEqual(["a-first", "b-second", "zzz"]);
    await store.updateSession(m.id, { pages: ["zzz"] });
    expect(await store.listPageIds(m.id)).toEqual(["zzz", "a-first", "b-second"]);

    const p1 = await store.getPage(m.id, "a-first");
    const p2 = await store.getPage(m.id, "a-first");
    expect(p1).toBe(p2); // cached by hash
    await store.writePage(m.id, "a-first", "---\norder: 1\n---\n# A2\n");
    const p3 = await store.getPage(m.id, "a-first");
    expect(p3.hash).not.toBe(p1.hash);

    await store.deletePage(m.id, "zzz");
    expect(await store.listPageIds(m.id)).toEqual(["a-first", "b-second"]);
    await expect(store.getPage(m.id, "zzz")).rejects.toBeInstanceOf(NotFound);
  });

  test("feedback lifecycle and batches", async () => {
    const m = await store.createSession({ id: "s2", title: "T", allowedRoots: [], meta: {} });
    const anchor = { pageId: "p", blockId: "p-1", block: null, selection: null, targetId: null };
    const f1 = await store.createFeedback(m.id, { kind: "change", anchor, body: "fix", author: "human" });
    const f2 = await store.createFeedback(m.id, { kind: "approve", anchor, body: "", author: "human" });
    expect((await store.listFeedback(m.id)).map((f) => f.id)).toEqual([f1.id, f2.id]);

    const sent = await store.sendBatch(m.id);
    expect(sent.batch).toBe(1);
    expect(sent.items.map((f) => f.id)).toEqual([f1.id, f2.id]);
    expect((await store.readManifest(m.id)).status).toBe("reviewed");

    const f3 = await store.createFeedback(m.id, { kind: "comment", anchor, body: "later", author: "human" });
    expect((await store.listFeedback(m.id, { since: 1 })).length).toBe(0); // f3 not batched yet
    const sent2 = await store.sendBatch(m.id);
    expect(sent2.items.map((f) => f.id)).toEqual([f3.id]);
    expect((await store.listFeedback(m.id, { since: 1 })).map((f) => f.id)).toEqual([f3.id]);
    expect((await store.listFeedback(m.id, { batch: 1 })).length).toBe(2);

    const replied = await store.addReply(m.id, f1.id, "agent", "done");
    expect(replied.status).toBe("acknowledged");
    expect(replied.replies[0]?.body).toBe("done");
    const resolved = await store.updateFeedback(m.id, f1.id, { status: "resolved" });
    expect(resolved.status).toBe("resolved");
    expect((await store.listFeedback(m.id, { status: "open" })).map((f) => f.id)).toEqual([f2.id, f3.id]);

    const summary = await store.summary(m.id);
    expect(summary.openFeedback).toBe(2);
  });

  test("external sessions are registered, watched and never deleted from disk", async () => {
    const ext = mkdtempSync(join(tmpdir(), "pp-ext-"));
    try {
      mkdirSync(join(ext, "pages"));
      writeFileSync(
        join(ext, "session.json"),
        JSON.stringify({ id: "ext1", title: "Ext", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
      );
      writeFileSync(join(ext, "pages", "01.mdx"), "# hi\n");
      const m = await store.registerExternal(ext);
      expect(m.id).toBe("ext1");
      expect(store.sessionDir("ext1")).toBe(ext);
      expect(store.sessionIdForPath(join(ext, "pages", "01.mdx"))).toBe("ext1");
      expect(store.watchRoots()).toContain(ext);
      expect(await store.listPageIds("ext1")).toEqual(["01"]);
      await store.deleteSession("ext1");
      expect(existsSync(join(ext, "session.json"))).toBe(true);
      expect(await store.listSessionIds()).toEqual([]);
    } finally {
      rmSync(ext, { recursive: true, force: true });
    }
  });

  test("assetPath refuses traversal and non-files", async () => {
    const m = await store.createSession({ id: "s3", title: "T", allowedRoots: [], meta: {} });
    writeFileSync(join(root, m.id, "assets", "a.txt"), "x");
    expect(await store.assetPath(m.id, "assets/a.txt")).toBe(join(root, m.id, "assets", "a.txt"));
    await expect(store.assetPath(m.id, "../registry.json")).rejects.toBeInstanceOf(NotFound);
    await expect(store.assetPath(m.id, "assets")).rejects.toBeInstanceOf(NotFound);
  });
});
