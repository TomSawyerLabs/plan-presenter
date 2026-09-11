import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Feedback, Reviewer, ReviewerPublic } from "@plan-presenter/protocol";
import { createHost, type Host } from "../src/app.ts";
import { Forbidden, SessionStore } from "../src/store.ts";

let root: string;
let store: SessionStore;

const anchor = { pageId: "p", blockId: "p-1", block: null, selection: null, targetId: null };
const comment = (body: string) => ({
  kind: "comment" as const,
  anchor,
  body,
  author: "human" as const,
});

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "pp-rev-"));
  store = new SessionStore(root);
  await store.init();
  await store.createSession({ id: "s", title: "T", allowedRoots: [], meta: {} });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("reviewers in the store", () => {
  test("create: random URL-safe token, persisted in session.json, stripped from the summary", async () => {
    const a = await store.createReviewer("s", { name: "Chris" });
    const b = await store.createReviewer("s", {});
    expect(a.id).toMatch(/^rv_[0-9a-f]{12}$/);
    expect(a.token.length).toBeGreaterThanOrEqual(16);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.token).not.toBe(b.token);
    expect(a.name).toBe("Chris");
    expect(b.name).toBeUndefined();

    const onDisk = JSON.parse(readFileSync(join(root, "s", "session.json"), "utf8"));
    expect(onDisk.version).toBe(2);
    expect(onDisk.reviewers.map((r: Reviewer) => r.token)).toEqual([a.token, b.token]);

    expect(await store.findReviewerByToken("s", a.token)).toEqual(a);
    expect(await store.findReviewerByToken("s", "nope")).toBeNull();

    const summary = await store.summary("s");
    expect(summary.reviewers.map((r) => r.id)).toEqual([a.id, b.id]);
    expect(summary.reviewers.some((r) => "token" in r)).toBe(false);
  });

  test("feedback and replies are stamped with the reviewer; the owner path is not", async () => {
    const chris = await store.createReviewer("s", { name: "Chris" });
    const mine = await store.createFeedback("s", comment("from chris"), chris);
    const owner = await store.createFeedback("s", comment("from owner"));
    expect(mine.reviewer).toEqual({ id: chris.id, name: "Chris" });
    expect(owner.reviewer).toBeUndefined();

    const replied = await store.addReply("s", owner.id, "human", "me too", chris);
    expect(replied.replies[0]?.reviewer).toEqual({ id: chris.id, name: "Chris" });
    const agentReply = await store.addReply("s", mine.id, "agent", "ok", chris);
    expect(agentReply.replies[0]?.reviewer).toBeUndefined();

    const seen = (await store.listReviewers("s")).find((r) => r.id === chris.id)!;
    expect(seen.lastSeenAt).toBeDefined();
    expect(seen.submittedAt).toBeUndefined();
  });

  test("a token may edit and delete only its own items; the owner path may touch anything", async () => {
    const chris = await store.createReviewer("s", { name: "Chris" });
    const dana = await store.createReviewer("s", { name: "Dana" });
    const c = await store.createFeedback("s", comment("c"), chris);
    const d = await store.createFeedback("s", comment("d"), dana);
    const o = await store.createFeedback("s", comment("o"));

    await expect(store.updateFeedback("s", d.id, { body: "x" }, chris)).rejects.toBeInstanceOf(
      Forbidden,
    );
    await expect(store.updateFeedback("s", o.id, { body: "x" }, chris)).rejects.toBeInstanceOf(
      Forbidden,
    );
    await expect(store.deleteFeedback("s", d.id, chris)).rejects.toBeInstanceOf(Forbidden);
    expect((await store.updateFeedback("s", c.id, { body: "mine" }, chris)).body).toBe("mine");
    await store.deleteFeedback("s", c.id, chris);

    // Owner path: no restriction.
    expect((await store.updateFeedback("s", d.id, { status: "resolved" })).status).toBe("resolved");
    await store.deleteFeedback("s", d.id);
    expect((await store.listFeedback("s")).map((f) => f.id)).toEqual([o.id]);
  });

  test("renaming copies the name onto existing items and replies", async () => {
    const r = await store.createReviewer("s", {});
    const f = await store.createFeedback("s", comment("hi"), r);
    expect(f.reviewer).toEqual({ id: r.id });
    await store.addReply("s", f.id, "human", "and again", r);
    const renamed = await store.updateReviewer("s", r.id, { name: "Chris" });
    expect(renamed.name).toBe("Chris");
    const [item] = await store.listFeedback("s");
    expect(item!.reviewer).toEqual({ id: r.id, name: "Chris" });
    expect(item!.replies[0]!.reviewer).toEqual({ id: r.id, name: "Chris" });
  });

  test("send batches only the reviewer's items and marks them submitted", async () => {
    const chris = await store.createReviewer("s", { name: "Chris" });
    const dana = await store.createReviewer("s", { name: "Dana" });
    const c = await store.createFeedback("s", comment("c"), chris);
    const d = await store.createFeedback("s", comment("d"), dana);
    const o = await store.createFeedback("s", comment("o"));

    const sent = await store.sendBatch("s", chris);
    expect(sent.batch).toBe(1);
    expect(sent.items.map((f) => f.id)).toEqual([c.id]);
    const after = await store.listFeedback("s");
    expect(after.find((f) => f.id === d.id)!.batch).toBeNull();
    expect(after.find((f) => f.id === o.id)!.batch).toBeNull();
    const reviewers = await store.listReviewers("s");
    expect(reviewers.find((r) => r.id === chris.id)!.submittedAt).toBeDefined();
    expect(reviewers.find((r) => r.id === dana.id)!.submittedAt).toBeUndefined();

    // Owner path still sweeps everything that is left.
    const all = await store.sendBatch("s");
    expect(all.items.map((f) => f.id).sort()).toEqual([d.id, o.id].sort());

    const done = await store.submitReview("s", dana.id);
    expect(done.submittedAt).toBeDefined();
  });

  test("a version-1 manifest (no reviewers, no version) still loads", async () => {
    const dir = join(root, "s");
    writeFileSync(
      join(dir, "session.json"),
      JSON.stringify({
        id: "s",
        title: "Old",
        status: "drafting",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const m = await store.readManifest("s");
    expect(m.version).toBe(2);
    expect(m.reviewers).toEqual([]);
    const r = await store.createReviewer("s", { name: "Late" });
    expect((await store.listReviewers("s")).map((x) => x.id)).toEqual([r.id]);
  });
});

describe("reviewer tokens over HTTP", () => {
  let host: Host;
  const json = (method: string, body?: unknown, token?: string) => ({
    method,
    headers: {
      "content-type": "application/json",
      ...(token && { "x-pp-reviewer": token }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

  beforeEach(async () => {
    host = await createHost({ root });
  });
  afterEach(async () => {
    await host.stop();
  });

  test("create, list, resolve via header or query, restrict, rename, submit, wake wait", async () => {
    const app = host.app;
    const created = await app.request("/api/sessions/s/reviewers", json("POST", { name: "Chris" }));
    expect(created.status).toBe(201);
    const chris = (await created.json()) as Reviewer;
    expect(chris.token.length).toBeGreaterThanOrEqual(16);
    // Empty body is fine: an unnamed reviewer.
    const anon = (await (
      await app.request("/api/sessions/s/reviewers", json("POST"))
    ).json()) as Reviewer;
    expect(anon.name).toBeUndefined();

    // The owner path sees tokens; a token holder does not.
    const ownerList = (await (await app.request("/api/sessions/s/reviewers")).json()) as Reviewer[];
    expect(ownerList.map((r) => r.token)).toEqual([chris.token, anon.token]);
    const reviewerList = (await (
      await app.request("/api/sessions/s/reviewers", json("GET", undefined, chris.token))
    ).json()) as ReviewerPublic[];
    expect(reviewerList.some((r) => "token" in r)).toBe(false);

    // /me with header and with query; unknown token is 403; none is 404.
    const me = await app.request(
      "/api/sessions/s/reviewers/me",
      json("GET", undefined, chris.token),
    );
    expect(me.status).toBe(200);
    expect(((await me.json()) as ReviewerPublic).id).toBe(chris.id);
    const meQuery = await app.request(`/api/sessions/s/reviewers/me?reviewer=${chris.token}`);
    expect(meQuery.status).toBe(200);
    expect((await app.request("/api/sessions/s/reviewers/me?reviewer=bogus")).status).toBe(403);
    expect((await app.request("/api/sessions/s/reviewers/me")).status).toBe(404);

    // Feedback created with a token is stamped; a bad token is refused.
    const fb = await app.request(
      "/api/sessions/s/feedback",
      json("POST", comment("hi"), chris.token),
    );
    expect(fb.status).toBe(201);
    const item = (await fb.json()) as Feedback;
    expect(item.reviewer).toEqual({ id: chris.id, name: "Chris" });
    expect(
      (await app.request("/api/sessions/s/feedback", json("POST", comment("no"), "bogus"))).status,
    ).toBe(403);

    // Another reviewer cannot edit or delete it; its owner can.
    expect(
      (
        await app.request(
          `/api/sessions/s/feedback/${item.id}`,
          json("PATCH", { body: "x" }, anon.token),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          `/api/sessions/s/feedback/${item.id}`,
          json("DELETE", undefined, anon.token),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          `/api/sessions/s/feedback/${item.id}`,
          json("PATCH", { body: "y" }, chris.token),
        )
      ).status,
    ).toBe(200);

    // Rename: only your own record.
    expect(
      (
        await app.request(
          `/api/sessions/s/reviewers/${anon.id}`,
          json("PATCH", { name: "X" }, chris.token),
        )
      ).status,
    ).toBe(403);
    const renamed = await app.request(
      `/api/sessions/s/reviewers/${anon.id}`,
      json("PATCH", { name: "Dana" }, anon.token),
    );
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as ReviewerPublic).name).toBe("Dana");
    expect(
      "token" in
        ((await (await app.request(`/api/sessions/s/reviewers`)).json()) as Reviewer[])[1]!,
    ).toBe(true);

    // A reviewer's send wakes `wait` with the reviewer in the event.
    const waiting = app.request("/api/sessions/s/wait?timeout=5000");
    await Bun.sleep(20);
    const sent = await app.request("/api/sessions/s/send", json("POST", undefined, chris.token));
    expect(sent.status).toBe(200);
    const woke = (await (await waiting).json()) as { timedOut: boolean; event: unknown };
    expect(woke.timedOut).toBe(false);
    expect(woke.event).toEqual({
      type: "feedback.batch",
      sessionId: "s",
      batch: 1,
      reviewer: { id: chris.id, name: "Chris" },
    });

    // "Done" without feedback also wakes wait.
    const waiting2 = app.request("/api/sessions/s/wait?timeout=5000");
    await Bun.sleep(20);
    const done = await app.request(
      `/api/sessions/s/reviewers/${anon.id}/submit`,
      json("POST", undefined, anon.token),
    );
    expect(done.status).toBe(200);
    expect(((await done.json()) as ReviewerPublic).submittedAt).toBeDefined();
    const woke2 = (await (await waiting2).json()) as { event: { type: string; reviewer: unknown } };
    expect(woke2.event.type).toBe("reviewer.submitted");
    expect(woke2.event.reviewer).toEqual({ id: anon.id, name: "Dana" });

    // The markdown the agent reads names the reviewer.
    const md = await (await app.request("/api/sessions/s/feedback?format=md")).text();
    expect(md).toContain("— Reviewer: Chris");
    expect(md).toContain("By reviewer: Chris (1)");
  });
});
