/**
 * Session store: a root directory of session folders plus a registry of
 * externally-located sessions.
 *
 *   <root>/
 *     registry.json            { external: { "<id>": "<abs dir>" } }
 *     <id>/                    a session (see layout below)
 *
 *   <session dir>/
 *     session.json             SessionManifest (agent-authored, host updates status/updatedAt)
 *     pages/*.mdx              one page per file; id = filename sans extension
 *     assets/**                images, video, data files; served read-only
 *     feedback.json            FeedbackFile (host-owned)
 *
 * Feedback is persisted to disk on every change so an agent can read it
 * directly (`cat feedback.json`) even if the host dies.
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  CompiledPage,
  Feedback,
  FeedbackFile,
  KNOWN_COMPONENTS,
  MANIFEST_VERSION,
  SessionManifest,
  type Anchor,
  type CreateFeedback,
  type CreateReviewer,
  type CreateSession,
  type PageSummary,
  type RenderErrorData,
  type ReportRenderError,
  type Reviewer,
  type ReviewerPublic,
  type ReviewerRef,
  type SessionSummary,
  type UpdateFeedback,
  type UpdateReviewer,
  type UpdateSession,
} from "@plan-presenter/protocol";
import { compilePage, hashSource } from "./compile.ts";

export class NotFound extends Error {
  override name = "NotFound";
}
export class Conflict extends Error {
  override name = "Conflict";
}
/** A reviewer token tried to touch something that is not theirs. */
export class Forbidden extends Error {
  override name = "Forbidden";
}

interface Registry {
  external: Record<string, string>;
}

const PAGE_EXT = /\.mdx?$/i;

function now(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** 24 random bytes as base64url: 32 chars, safe in a URL without encoding. */
function newToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
}

/** What gets stamped onto feedback: the reviewer's id and current name. */
export function reviewerRef(r: Reviewer): ReviewerRef {
  return r.name === undefined ? { id: r.id } : { id: r.id, name: r.name };
}

export function publicReviewer({ token: _token, ...rest }: Reviewer): ReviewerPublic {
  return rest;
}

/** Ownership rule for token-bearing requests: only your own items. */
function assertOwner(item: Feedback, reviewer: Reviewer | undefined, verb: string): void {
  if (reviewer && item.reviewer?.id !== reviewer.id)
    throw new Forbidden(`reviewer ${reviewer.id} may not ${verb} feedback ${item.id}`);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  // Windows refuses to replace a file that another handle (watcher, AV, a
  // reader) has open for a moment; retry briefly before giving up.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && attempt < 8) {
        await Bun.sleep(15 * (attempt + 1));
        continue;
      }
      await rm(tmp, { force: true });
      throw err;
    }
  }
}

export class SessionStore {
  readonly root: string;
  private registry: Registry = { external: {} };
  private compiled = new Map<string, CompiledPage>();
  /** Per-session write chain: every read-modify-write of a session's files runs in turn. */
  private chains = new Map<string, Promise<unknown>>();

  /**
   * Serialise mutations per session. Concurrent writers (viewer feedback,
   * render-error reports, compile-time reports from `summary`) otherwise race
   * on feedback.json and session.json: lost updates and EPERM on Windows.
   * Not re-entrant: never call a locked method from inside another.
   */
  private locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.chains.set(id, next);
    // The caller handles `next`'s rejection; this derived promise must not
    // re-raise it as an unhandled rejection.
    void next
      .finally(() => {
        if (this.chains.get(id) === next) this.chains.delete(id);
      })
      .catch(() => undefined);
    return next;
  }

  constructor(root: string) {
    this.root = resolve(root);
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const p = join(this.root, "registry.json");
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(await readFile(p, "utf8")) as Partial<Registry>;
        this.registry = { external: raw.external ?? {} };
      } catch {
        this.registry = { external: {} };
      }
    }
  }

  private async saveRegistry(): Promise<void> {
    await writeJsonAtomic(join(this.root, "registry.json"), this.registry);
  }

  // ------------------------------------------------------------- sessions

  /** Absolute directory for a session id, whether internal or registered. */
  sessionDir(id: string): string {
    return this.registry.external[id] ?? join(this.root, id);
  }

  /** Reverse lookup used by the watcher: which session owns this path? */
  sessionIdForPath(path: string): string | null {
    const p = resolve(path);
    for (const [id, dir] of Object.entries(this.registry.external)) {
      if (p.startsWith(resolve(dir))) return id;
    }
    if (p.startsWith(this.root)) {
      const rest = p.slice(this.root.length).replace(/^[\\/]/, "");
      const first = rest.split(/[\\/]/)[0];
      return first && first !== "registry.json" ? first : null;
    }
    return null;
  }

  watchRoots(): string[] {
    return [this.root, ...Object.values(this.registry.external)];
  }

  async listSessionIds(): Promise<string[]> {
    const ids = new Set<string>(Object.keys(this.registry.external));
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(this.root, entry.name, "session.json"))) {
        ids.add(entry.name);
      }
    }
    return [...ids].sort();
  }

  async readManifest(id: string): Promise<SessionManifest> {
    const p = join(this.sessionDir(id), "session.json");
    if (!existsSync(p)) throw new NotFound(`session ${id}`);
    const parsed = SessionManifest.safeParse(JSON.parse(await readFile(p, "utf8")));
    if (!parsed.success) throw new Error(`invalid session.json for ${id}: ${parsed.error.message}`);
    return parsed.data;
  }

  private async writeManifest(m: SessionManifest): Promise<void> {
    await writeJsonAtomic(join(this.sessionDir(m.id), "session.json"), m);
  }

  async createSession(input: CreateSession, opts: { dir?: string } = {}): Promise<SessionManifest> {
    const id = input.id ?? newId("s").replace("_", "-");
    if (existsSync(join(this.sessionDir(id), "session.json")))
      throw new Conflict(`session ${id} exists`);
    if (opts.dir) {
      this.registry.external[id] = resolve(opts.dir);
      await this.saveRegistry();
    }
    const dir = this.sessionDir(id);
    await mkdir(join(dir, "pages"), { recursive: true });
    await mkdir(join(dir, "assets"), { recursive: true });
    const ts = now();
    const manifest: SessionManifest = {
      version: MANIFEST_VERSION,
      id,
      title: input.title,
      status: "drafting",
      createdAt: ts,
      updatedAt: ts,
      allowedRoots: input.allowedRoots.map((r) => resolve(r)),
      pages: [],
      meta: input.meta,
      reviewers: [],
    };
    await this.writeManifest(manifest);
    await this.writeFeedbackFile(id, { version: 1, lastBatch: 0, items: [] });
    return manifest;
  }

  /** Register an existing directory that already contains session.json. */
  async registerExternal(dir: string): Promise<SessionManifest> {
    const abs = resolve(dir);
    const p = join(abs, "session.json");
    if (!existsSync(p)) throw new NotFound(`no session.json in ${abs}`);
    const parsed = SessionManifest.parse(JSON.parse(await readFile(p, "utf8")));
    this.registry.external[parsed.id] = abs;
    await this.saveRegistry();
    return parsed;
  }

  updateSession(id: string, patch: UpdateSession): Promise<SessionManifest> {
    return this.locked(id, () => this.applySessionPatch(id, patch));
  }

  private async applySessionPatch(id: string, patch: UpdateSession): Promise<SessionManifest> {
    const m = await this.readManifest(id);
    const next: SessionManifest = {
      ...m,
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.allowedRoots !== undefined && {
        allowedRoots: patch.allowedRoots.map((r) => resolve(r)),
      }),
      ...(patch.pages !== undefined && { pages: patch.pages }),
      ...(patch.meta !== undefined && { meta: { ...m.meta, ...patch.meta } }),
      updatedAt: now(),
    };
    await this.writeManifest(next);
    return next;
  }

  async deleteSession(id: string): Promise<void> {
    const dir = this.sessionDir(id);
    if (!existsSync(join(dir, "session.json"))) throw new NotFound(`session ${id}`);
    if (this.registry.external[id]) {
      // Never delete a directory we didn't create; just forget it.
      delete this.registry.external[id];
      await this.saveRegistry();
    } else {
      await rm(dir, { recursive: true, force: true });
    }
    for (const key of this.compiled.keys()) if (key.startsWith(`${id}/`)) this.compiled.delete(key);
  }

  async summary(id: string): Promise<SessionSummary> {
    const m = await this.readManifest(id);
    const pageIds = await this.listPageIds(id);
    const fb = await this.readFeedbackFile(id);
    const open = fb.items.filter((f) => f.status === "open");
    const pageSummaries: PageSummary[] = [];
    for (const pid of pageIds) {
      const page = await this.getPage(id, pid);
      pageSummaries.push({
        id: pid,
        title: page.frontmatter.title ?? titleFromId(pid),
        openFeedback: open.filter((f) => f.anchor.pageId === pid).length,
      });
    }
    return {
      ...m,
      dir: this.sessionDir(id),
      pageSummaries,
      openFeedback: open.length,
      // Browsers get the list but never the tokens.
      reviewers: m.reviewers.map(publicReviewer),
    };
  }

  // ------------------------------------------------------------ reviewers

  async listReviewers(id: string): Promise<Reviewer[]> {
    return (await this.readManifest(id)).reviewers;
  }

  /** Resolve an invite token for a session; null when it is not one of ours. */
  async findReviewerByToken(id: string, token: string): Promise<Reviewer | null> {
    const m = await this.readManifest(id);
    return m.reviewers.find((r) => r.token === token) ?? null;
  }

  createReviewer(id: string, input: CreateReviewer): Promise<Reviewer> {
    return this.locked(id, async () => {
      const m = await this.readManifest(id);
      const ts = now();
      const reviewer: Reviewer = {
        id: newId("rv"),
        token: newToken(),
        ...(input.name !== undefined && { name: input.name }),
        createdAt: ts,
      };
      m.reviewers.push(reviewer);
      m.updatedAt = ts;
      await this.writeManifest(m);
      return reviewer;
    });
  }

  /**
   * Rename a reviewer. The name is copied onto their existing feedback and
   * replies too, so feedback.json stays self-describing for agents reading it
   * directly.
   */
  updateReviewer(id: string, reviewerId: string, patch: UpdateReviewer): Promise<Reviewer> {
    return this.locked(id, async () => {
      const m = await this.readManifest(id);
      const r = m.reviewers.find((x) => x.id === reviewerId);
      if (!r) throw new NotFound(`reviewer ${reviewerId}`);
      r.name = patch.name;
      m.updatedAt = now();
      await this.writeManifest(m);
      const file = await this.readFeedbackFile(id);
      let changed = false;
      for (const f of file.items) {
        if (f.reviewer?.id === reviewerId) {
          f.reviewer = reviewerRef(r);
          changed = true;
        }
        for (const rep of f.replies) {
          if (rep.reviewer?.id === reviewerId) {
            rep.reviewer = reviewerRef(r);
            changed = true;
          }
        }
      }
      if (changed) await this.writeFeedbackFile(id, file);
      return r;
    });
  }

  /** Record that a reviewer opened their link (writes only lastSeenAt). */
  markReviewerSeen(id: string, reviewerId: string): Promise<void> {
    return this.locked(id, () => this.touch(id, { reviewerId }));
  }

  /** The reviewer says they are done (with or without feedback to send). */
  submitReview(id: string, reviewerId: string): Promise<Reviewer> {
    return this.locked(id, async () => {
      const m = await this.readManifest(id);
      const r = m.reviewers.find((x) => x.id === reviewerId);
      if (!r) throw new NotFound(`reviewer ${reviewerId}`);
      const ts = now();
      r.submittedAt = ts;
      r.lastSeenAt = ts;
      m.updatedAt = ts;
      await this.writeManifest(m);
      return r;
    });
  }

  // ---------------------------------------------------------------- pages

  pagePath(id: string, pageId: string): string {
    return join(this.sessionDir(id), "pages", `${pageId}.mdx`);
  }

  async listPageIds(id: string): Promise<string[]> {
    const m = await this.readManifest(id);
    const dir = join(this.sessionDir(id), "pages");
    if (!existsSync(dir)) return [];
    const files = (await readdir(dir)).filter((f) => PAGE_EXT.test(f));
    const ids = files.map((f) => f.replace(PAGE_EXT, ""));
    // Manifest order first, then remaining by frontmatter.order, then name.
    const pinned = m.pages.filter((p) => ids.includes(p));
    const rest = ids.filter((p) => !pinned.includes(p));
    const withOrder = await Promise.all(
      rest.map(async (pid) => ({
        pid,
        order: (await this.getPage(id, pid)).frontmatter.order ?? Infinity,
      })),
    );
    withOrder.sort((a, b) => a.order - b.order || a.pid.localeCompare(b.pid));
    return [...pinned, ...withOrder.map((w) => w.pid)];
  }

  async readPageSource(id: string, pageId: string): Promise<string> {
    const p = this.pagePath(id, pageId);
    const alt = p.replace(/\.mdx$/, ".md");
    const path = existsSync(p) ? p : existsSync(alt) ? alt : null;
    if (!path) throw new NotFound(`page ${id}/${pageId}`);
    return readFile(path, "utf8");
  }

  async getPage(id: string, pageId: string): Promise<CompiledPage> {
    const source = await this.readPageSource(id, pageId);
    const key = `${id}/${pageId}`;
    const cached = this.compiled.get(key);
    const hash = hashSource(source);
    if (cached && cached.hash === hash) return cached;
    const result = await compilePage(source, `${pageId}.mdx`);
    const page: CompiledPage = {
      sessionId: id,
      id: pageId,
      frontmatter: result.frontmatter,
      code: result.code,
      blocks: result.blocks,
      hash,
      error: result.error,
      unknownComponents: result.unknownComponents.map((u) => u.name),
    };
    this.compiled.set(key, page);
    // The content changed (or this is the first compile since start): every
    // earlier render error for this page is stale. Viewer-side ones come back
    // on the next render if they still apply. This does not depend on the file
    // watcher, so a write the watcher missed still clears its errors here.
    await this.resolveRenderErrors(id, pageId);
    // Compile problems go straight to the agent as system feedback.
    if (result.error) {
      await this.reportRenderError(id, {
        pageId,
        blockId: null,
        block: null,
        targetId: null,
        source: "compile",
        message: result.error,
        detail: null,
      });
    }
    for (const u of result.unknownComponents) {
      const block =
        result.blocks.find((b) => b.line.start <= u.line && u.line <= b.line.end) ?? null;
      await this.reportRenderError(id, {
        pageId,
        blockId: block?.id ?? null,
        block,
        targetId: null,
        source: "component",
        message: `Unknown component <${u.name}> (line ${u.line}). Available: ${KNOWN_COMPONENTS.join(", ")}`,
        detail: null,
      });
    }
    return page;
  }

  async writePage(id: string, pageId: string, source: string): Promise<void> {
    await this.readManifest(id);
    await mkdir(join(this.sessionDir(id), "pages"), { recursive: true });
    await writeFile(this.pagePath(id, pageId), source, "utf8");
    this.compiled.delete(`${id}/${pageId}`);
  }

  async deletePage(id: string, pageId: string): Promise<void> {
    const p = this.pagePath(id, pageId);
    if (!existsSync(p)) throw new NotFound(`page ${id}/${pageId}`);
    await rm(p);
    this.compiled.delete(`${id}/${pageId}`);
  }

  invalidatePage(id: string, pageId: string): void {
    this.compiled.delete(`${id}/${pageId}`);
  }

  /** Resolve an asset path inside the session dir, refusing traversal. */
  async assetPath(id: string, rel: string): Promise<string> {
    const dir = resolve(this.sessionDir(id));
    const abs = resolve(dir, rel);
    if (!abs.startsWith(dir)) throw new NotFound(`asset ${rel}`);
    try {
      const s = await stat(abs);
      if (!s.isFile()) throw new NotFound(`asset ${rel}`);
    } catch {
      throw new NotFound(`asset ${rel}`);
    }
    return abs;
  }

  // ------------------------------------------------------------- feedback

  private feedbackPath(id: string): string {
    return join(this.sessionDir(id), "feedback.json");
  }

  async readFeedbackFile(id: string): Promise<FeedbackFile> {
    const p = this.feedbackPath(id);
    if (!existsSync(p)) {
      if (!existsSync(join(this.sessionDir(id), "session.json")))
        throw new NotFound(`session ${id}`);
      return { version: 1, lastBatch: 0, items: [] };
    }
    const parsed = FeedbackFile.safeParse(JSON.parse(await readFile(p, "utf8")));
    if (!parsed.success)
      throw new Error(`invalid feedback.json for ${id}: ${parsed.error.message}`);
    return parsed.data;
  }

  private async writeFeedbackFile(id: string, file: FeedbackFile): Promise<void> {
    await writeJsonAtomic(this.feedbackPath(id), file);
  }

  async listFeedback(
    id: string,
    filter: {
      pageId?: string;
      status?: string;
      batch?: number;
      since?: number;
      kind?: string;
      author?: string;
    } = {},
  ): Promise<Feedback[]> {
    const file = await this.readFeedbackFile(id);
    return file.items.filter(
      (f) =>
        (filter.pageId === undefined || f.anchor.pageId === filter.pageId) &&
        (filter.status === undefined || f.status === filter.status) &&
        (filter.kind === undefined || f.kind === filter.kind) &&
        (filter.author === undefined || f.author === filter.author) &&
        (filter.batch === undefined || f.batch === filter.batch) &&
        (filter.since === undefined || (f.batch !== null && f.batch > filter.since)),
    );
  }

  // --------------------------------------------------------- render errors

  /**
   * Called after a render error is created or reopened (not on repeats of an
   * already-open error). The app uses it to wake `pp wait` and refresh the UI.
   */
  onRenderError: ((item: Feedback, created: boolean) => void) | null = null;

  /**
   * Record a rendering problem as system feedback. Deduplicated on
   * page + block + source + message: a repeat bumps `data.count`; a repeat of
   * a resolved error reopens it.
   */
  reportRenderError(
    id: string,
    input: ReportRenderError,
  ): Promise<{ item: Feedback; created: boolean; reopened: boolean }> {
    return this.locked(id, () => this.reportRenderErrorUnlocked(id, input));
  }

  private async reportRenderErrorUnlocked(
    id: string,
    input: ReportRenderError,
  ): Promise<{ item: Feedback; created: boolean; reopened: boolean }> {
    const file = await this.readFeedbackFile(id);
    // Viewer reports carry only a block id; fill in the snapshot (lines, excerpt)
    // from the compiled page so the agent gets a location.
    if (!input.block && input.blockId) {
      const cached = this.compiled.get(`${id}/${input.pageId}`);
      input = { ...input, block: cached?.blocks.find((b) => b.id === input.blockId) ?? null };
    }
    const ts = now();
    const existing = file.items.find(
      (f) =>
        f.author === "system" &&
        f.kind === "error" &&
        f.anchor.pageId === input.pageId &&
        f.anchor.blockId === input.blockId &&
        (f.data as RenderErrorData | undefined)?.source === input.source &&
        f.body === input.message,
    );
    if (existing) {
      const data = (existing.data as RenderErrorData | undefined) ?? {
        source: input.source,
        detail: null,
        count: 0,
      };
      const reopened = existing.status === "resolved";
      if (!existing.anchor.block && input.block) existing.anchor.block = input.block;
      existing.data = { ...data, detail: input.detail ?? data.detail, count: data.count + 1 };
      existing.status = "open";
      existing.updatedAt = ts;
      await this.writeFeedbackFile(id, file);
      if (reopened) {
        await this.touch(id);
        this.onRenderError?.(existing, false);
      }
      return { item: existing, created: false, reopened };
    }
    const data: RenderErrorData = { source: input.source, detail: input.detail, count: 1 };
    const item: Feedback = Feedback.parse({
      id: newId("err"),
      sessionId: id,
      kind: "error",
      status: "open",
      author: "system",
      anchor: {
        pageId: input.pageId,
        blockId: input.blockId,
        block: input.block,
        selection: null,
        targetId: input.targetId,
      },
      body: input.message,
      data,
      createdAt: ts,
      updatedAt: ts,
      replies: [],
      batch: null,
    });
    file.items.push(item);
    await this.writeFeedbackFile(id, file);
    await this.touch(id);
    this.onRenderError?.(item, true);
    return { item, created: true, reopened: false };
  }

  /** Resolve open render errors for a page (all sources, or only the given ones). */
  resolveRenderErrors(id: string, pageId: string, sources?: string[]): Promise<number> {
    return this.locked(id, () => this.resolveRenderErrorsUnlocked(id, pageId, sources));
  }

  private async resolveRenderErrorsUnlocked(
    id: string,
    pageId: string,
    sources?: string[],
  ): Promise<number> {
    const file = await this.readFeedbackFile(id);
    let n = 0;
    for (const f of file.items) {
      if (f.author !== "system" || f.kind !== "error" || f.status === "resolved") continue;
      if (f.anchor.pageId !== pageId) continue;
      const src = (f.data as RenderErrorData | undefined)?.source;
      if (sources && (!src || !sources.includes(src))) continue;
      f.status = "resolved";
      f.updatedAt = now();
      n++;
    }
    if (n > 0) await this.writeFeedbackFile(id, file);
    return n;
  }

  /**
   * The optional `reviewer` on the mutators below is the resolved invite-token
   * holder. With one, new items/replies are stamped with `{id, name}`, edits
   * and deletes are limited to that reviewer's own items, and "send" batches
   * only their items. Without one (the owner path) behaviour is unchanged.
   */
  createFeedback(id: string, input: CreateFeedback, reviewer?: Reviewer): Promise<Feedback> {
    return this.locked(id, () => this.createFeedbackUnlocked(id, input, reviewer));
  }

  private async createFeedbackUnlocked(
    id: string,
    input: CreateFeedback,
    reviewer?: Reviewer,
  ): Promise<Feedback> {
    const file = await this.readFeedbackFile(id);
    const ts = now();
    const item: Feedback = Feedback.parse({
      id: newId("fb"),
      sessionId: id,
      kind: input.kind,
      status: "open",
      author: input.author,
      ...(reviewer && input.author === "human" && { reviewer: reviewerRef(reviewer) }),
      anchor: input.anchor as Anchor,
      body: input.body,
      data: input.data,
      createdAt: ts,
      updatedAt: ts,
      replies: [],
      batch: null,
    });
    file.items.push(item);
    await this.writeFeedbackFile(id, file);
    await this.touch(id, reviewer && { reviewerId: reviewer.id });
    return item;
  }

  updateFeedback(
    id: string,
    feedbackId: string,
    patch: UpdateFeedback,
    reviewer?: Reviewer,
  ): Promise<Feedback> {
    return this.locked(id, () => this.updateFeedbackUnlocked(id, feedbackId, patch, reviewer));
  }

  private async updateFeedbackUnlocked(
    id: string,
    feedbackId: string,
    patch: UpdateFeedback,
    reviewer?: Reviewer,
  ): Promise<Feedback> {
    const file = await this.readFeedbackFile(id);
    const item = file.items.find((f) => f.id === feedbackId);
    if (!item) throw new NotFound(`feedback ${feedbackId}`);
    assertOwner(item, reviewer, "edit");
    if (patch.body !== undefined) item.body = patch.body;
    if (patch.kind !== undefined) item.kind = patch.kind;
    if (patch.status !== undefined) item.status = patch.status;
    item.updatedAt = now();
    await this.writeFeedbackFile(id, file);
    await this.touch(id, reviewer && { reviewerId: reviewer.id });
    return item;
  }

  deleteFeedback(id: string, feedbackId: string, reviewer?: Reviewer): Promise<void> {
    return this.locked(id, async () => {
      const file = await this.readFeedbackFile(id);
      const idx = file.items.findIndex((f) => f.id === feedbackId);
      if (idx < 0) throw new NotFound(`feedback ${feedbackId}`);
      assertOwner(file.items[idx]!, reviewer, "delete");
      file.items.splice(idx, 1);
      await this.writeFeedbackFile(id, file);
      if (reviewer) await this.touch(id, { reviewerId: reviewer.id });
    });
  }

  addReply(
    id: string,
    feedbackId: string,
    author: "human" | "agent",
    body: string,
    reviewer?: Reviewer,
  ): Promise<Feedback> {
    return this.locked(id, () => this.addReplyUnlocked(id, feedbackId, author, body, reviewer));
  }

  private async addReplyUnlocked(
    id: string,
    feedbackId: string,
    author: "human" | "agent",
    body: string,
    reviewer?: Reviewer,
  ): Promise<Feedback> {
    const file = await this.readFeedbackFile(id);
    const item = file.items.find((f) => f.id === feedbackId);
    if (!item) throw new NotFound(`feedback ${feedbackId}`);
    // Replies are conversation, not edits: a reviewer may reply on anyone's item.
    item.replies.push({
      id: newId("r"),
      author,
      ...(reviewer && author === "human" && { reviewer: reviewerRef(reviewer) }),
      body,
      createdAt: now(),
    });
    if (author === "agent" && item.status === "open") item.status = "acknowledged";
    item.updatedAt = now();
    await this.writeFeedbackFile(id, file);
    await this.touch(id, reviewer && { reviewerId: reviewer.id });
    return item;
  }

  /**
   * "Send to agent": stamp every un-batched item with a new batch number and
   * flip the session to `reviewed`. Returns the batch number and its items.
   * For a reviewer, only their own pending items go, and they are marked
   * submitted.
   */
  sendBatch(id: string, reviewer?: Reviewer): Promise<{ batch: number; items: Feedback[] }> {
    return this.locked(id, async () => {
      const file = await this.readFeedbackFile(id);
      // System-reported render errors reach the agent on their own; they are
      // never part of a human batch.
      const pending = file.items.filter(
        (f) =>
          f.batch === null &&
          f.author !== "system" &&
          (!reviewer || f.reviewer?.id === reviewer.id),
      );
      const batch = file.lastBatch + 1;
      for (const f of pending) f.batch = batch;
      file.lastBatch = batch;
      await this.writeFeedbackFile(id, file);
      await this.applySessionPatch(id, { status: "reviewed" });
      if (reviewer) await this.touch(id, { reviewerId: reviewer.id, submitted: true });
      return { batch, items: pending };
    });
  }

  /** Bump updatedAt; with `mark`, also record that a reviewer was here (or is done). */
  private async touch(
    id: string,
    mark?: { reviewerId: string; submitted?: boolean },
  ): Promise<void> {
    try {
      const m = await this.readManifest(id);
      const ts = now();
      m.updatedAt = ts;
      const r = mark && m.reviewers.find((x) => x.id === mark.reviewerId);
      if (r) {
        r.lastSeenAt = ts;
        if (mark?.submitted) r.submittedAt = ts;
      }
      await this.writeManifest(m);
    } catch {
      /* session may be mid-delete */
    }
  }
}

export function titleFromId(pageId: string): string {
  return (
    basename(pageId)
      .replace(/^\d+[-_.]?/, "")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase()) || pageId
  );
}
