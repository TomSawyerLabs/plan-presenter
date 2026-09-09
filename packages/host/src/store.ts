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
  SessionManifest,
  type Anchor,
  type CreateFeedback,
  type CreateSession,
  type PageSummary,
  type SessionSummary,
  type UpdateFeedback,
  type UpdateSession,
} from "@plan-presenter/protocol";
import { compilePage, hashSource } from "./compile.ts";

export class NotFound extends Error {
  override name = "NotFound";
}
export class Conflict extends Error {
  override name = "Conflict";
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

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

export class SessionStore {
  readonly root: string;
  private registry: Registry = { external: {} };
  private compiled = new Map<string, CompiledPage>();

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
      id,
      title: input.title,
      status: "drafting",
      createdAt: ts,
      updatedAt: ts,
      allowedRoots: input.allowedRoots.map((r) => resolve(r)),
      pages: [],
      meta: input.meta,
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

  async updateSession(id: string, patch: UpdateSession): Promise<SessionManifest> {
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
    return { ...m, dir: this.sessionDir(id), pageSummaries, openFeedback: open.length };
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
    };
    this.compiled.set(key, page);
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
    filter: { pageId?: string; status?: string; batch?: number; since?: number } = {},
  ): Promise<Feedback[]> {
    const file = await this.readFeedbackFile(id);
    return file.items.filter(
      (f) =>
        (filter.pageId === undefined || f.anchor.pageId === filter.pageId) &&
        (filter.status === undefined || f.status === filter.status) &&
        (filter.batch === undefined || f.batch === filter.batch) &&
        (filter.since === undefined || (f.batch !== null && f.batch > filter.since)),
    );
  }

  async createFeedback(id: string, input: CreateFeedback): Promise<Feedback> {
    const file = await this.readFeedbackFile(id);
    const ts = now();
    const item: Feedback = Feedback.parse({
      id: newId("fb"),
      sessionId: id,
      kind: input.kind,
      status: "open",
      author: input.author,
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
    await this.touch(id);
    return item;
  }

  async updateFeedback(id: string, feedbackId: string, patch: UpdateFeedback): Promise<Feedback> {
    const file = await this.readFeedbackFile(id);
    const item = file.items.find((f) => f.id === feedbackId);
    if (!item) throw new NotFound(`feedback ${feedbackId}`);
    if (patch.body !== undefined) item.body = patch.body;
    if (patch.kind !== undefined) item.kind = patch.kind;
    if (patch.status !== undefined) item.status = patch.status;
    item.updatedAt = now();
    await this.writeFeedbackFile(id, file);
    await this.touch(id);
    return item;
  }

  async deleteFeedback(id: string, feedbackId: string): Promise<void> {
    const file = await this.readFeedbackFile(id);
    const idx = file.items.findIndex((f) => f.id === feedbackId);
    if (idx < 0) throw new NotFound(`feedback ${feedbackId}`);
    file.items.splice(idx, 1);
    await this.writeFeedbackFile(id, file);
  }

  async addReply(
    id: string,
    feedbackId: string,
    author: "human" | "agent",
    body: string,
  ): Promise<Feedback> {
    const file = await this.readFeedbackFile(id);
    const item = file.items.find((f) => f.id === feedbackId);
    if (!item) throw new NotFound(`feedback ${feedbackId}`);
    item.replies.push({ id: newId("r"), author, body, createdAt: now() });
    if (author === "agent" && item.status === "open") item.status = "acknowledged";
    item.updatedAt = now();
    await this.writeFeedbackFile(id, file);
    await this.touch(id);
    return item;
  }

  /**
   * "Send to agent": stamp every un-batched item with a new batch number and
   * flip the session to `reviewed`. Returns the batch number and its items.
   */
  async sendBatch(id: string): Promise<{ batch: number; items: Feedback[] }> {
    const file = await this.readFeedbackFile(id);
    const pending = file.items.filter((f) => f.batch === null);
    const batch = file.lastBatch + 1;
    for (const f of pending) f.batch = batch;
    file.lastBatch = batch;
    await this.writeFeedbackFile(id, file);
    await this.updateSession(id, { status: "reviewed" });
    return { batch, items: pending };
  }

  private async touch(id: string): Promise<void> {
    try {
      const m = await this.readManifest(id);
      m.updatedAt = now();
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
