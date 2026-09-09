/**
 * Filesystem watcher: turns changes inside session directories into
 * LiveEvents. Debounced per path because editors and agents often write a
 * file several times in quick succession.
 */

import { watch, type FSWatcher } from "chokidar";
import { basename, relative, sep } from "node:path";
import type { LiveEvent } from "@plan-presenter/protocol";
import type { SessionStore } from "./store.ts";

export type EventSink = (event: LiveEvent) => void;

export class SessionWatcher {
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private store: SessionStore,
    private emit: EventSink,
    private debounceMs = 80,
  ) {}

  start(): void {
    this.watcher = watch(this.store.watchRoots(), {
      ignoreInitial: true,
      ignored: (p) => /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(p) || p.endsWith(".tmp"),
      awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 },
    });
    this.watcher.on("all", (kind, path) => this.schedule(kind, path));
  }

  /** Call after registering an external session directory. */
  add(dir: string): void {
    this.watcher?.add(dir);
  }

  async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await this.watcher?.close();
    this.watcher = null;
  }

  private schedule(kind: string, path: string): void {
    const key = `${kind}:${path}`;
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.handle(kind, path);
      }, this.debounceMs),
    );
  }

  private handle(kind: string, path: string): void {
    const sessionId = this.store.sessionIdForPath(path);
    if (!sessionId) return;
    const dir = this.store.sessionDir(sessionId);
    const rel = relative(dir, path).split(sep).join("/");
    const name = basename(path);

    if (rel === "session.json") {
      this.emit(
        kind === "unlink"
          ? { type: "session.removed", sessionId }
          : { type: "session.changed", sessionId },
      );
      return;
    }
    if (rel === "feedback.json") {
      // Agent edited feedback.json directly (or pp CLI wrote through the file).
      this.emit({ type: "session.changed", sessionId });
      return;
    }
    if (rel.startsWith("pages/") && /\.mdx?$/i.test(name)) {
      const pageId = name.replace(/\.mdx?$/i, "");
      this.store.invalidatePage(sessionId, pageId);
      this.emit(
        kind === "unlink"
          ? { type: "page.removed", sessionId, pageId }
          : { type: "page.changed", sessionId, pageId },
      );
      return;
    }
    if (rel.startsWith("assets/") || rel.startsWith("data/")) {
      this.emit({ type: "asset.changed", sessionId, path: rel });
    }
  }
}
