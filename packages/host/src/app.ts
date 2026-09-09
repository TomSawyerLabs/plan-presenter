/**
 * Hono application: REST + WebSocket + static UI.
 *
 * This is one adapter over the framework-agnostic core (`SessionStore`,
 * `SessionWatcher`, `openInFileManager`). A native t3code integration would
 * wrap the same core in its own Effect services instead of mounting this app.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CreateFeedback,
  CreateReply,
  CreateSession,
  OpenPathRequest,
  UpdateFeedback,
  UpdateSession,
  formatFeedbackMarkdown,
  type LiveEvent,
} from "@plan-presenter/protocol";
import { z } from "zod";
import { openInFileManager, OpenRefused } from "./open.ts";
import { Conflict, NotFound, SessionStore } from "./store.ts";
import { SessionWatcher } from "./watcher.ts";

export const HOST_VERSION = "0.0.0";

export interface HostOptions {
  /** Directory holding session folders + registry. */
  root: string;
  /** Built UI directory (contains index.html). Optional in dev (Vite serves it). */
  uiDir?: string;
  /** Called for every live event; used by embedders that want their own transport. */
  onEvent?: (event: LiveEvent) => void;
}

export interface Host {
  app: Hono;
  store: SessionStore;
  watcher: SessionWatcher;
  websocket: ReturnType<typeof createBunWebSocket<ServerWebSocket>>["websocket"];
  broadcast: (event: LiveEvent) => void;
  stop: () => Promise<void>;
}

const RegisterSession = z.object({ dir: z.string().min(1) });
const FeedbackQuery = z.object({
  format: z.enum(["json", "md"]).optional(),
  pageId: z.string().optional(),
  status: z.string().optional(),
  batch: z.coerce.number().int().optional(),
  since: z.coerce.number().int().optional(),
});
const PageBody = z.object({ source: z.string() });

export async function createHost(opts: HostOptions): Promise<Host> {
  const store = new SessionStore(opts.root);
  await store.init();

  const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();
  const clients = new Set<{ send: (data: string) => void }>();
  // Long-poll waiters (agent CLI `pp wait`) keyed by session id.
  const waiters = new Map<string, Set<(e: LiveEvent) => void>>();

  const broadcast = (event: LiveEvent) => {
    const data = JSON.stringify(event);
    for (const c of clients) {
      try {
        c.send(data);
      } catch {
        clients.delete(c);
      }
    }
    const sid = "sessionId" in event ? event.sessionId : null;
    if (sid) for (const w of waiters.get(sid) ?? []) w(event);
    opts.onEvent?.(event);
  };

  const watcher = new SessionWatcher(store, broadcast);
  watcher.start();

  const app = new Hono();
  app.use("/api/*", cors());

  app.onError((err, c) => {
    if (err instanceof NotFound) return c.json({ error: err.message }, 404);
    if (err instanceof Conflict) return c.json({ error: err.message }, 409);
    if (err instanceof OpenRefused) return c.json({ error: err.message }, 403);
    if (err instanceof z.ZodError) return c.json({ error: "invalid request", issues: err.issues }, 400);
    if (err instanceof SyntaxError) return c.json({ error: `invalid JSON: ${err.message}` }, 400);
    console.error(err);
    return c.json({ error: err.message ?? "internal error" }, 500);
  });

  // ----------------------------------------------------------------- meta
  app.get("/api/health", (c) => c.json({ ok: true, version: HOST_VERSION, root: store.root }));

  // ------------------------------------------------------------- sessions
  app.get("/api/sessions", async (c) => {
    const ids = await store.listSessionIds();
    const summaries = await Promise.all(
      ids.map(async (id) => {
        try {
          return await store.summary(id);
        } catch (err) {
          console.warn(`skipping session ${id}:`, (err as Error).message);
          return null;
        }
      }),
    );
    return c.json(summaries.filter((s) => s !== null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  });

  app.post("/api/sessions", async (c) => {
    const body = CreateSession.parse(await c.req.json());
    const m = await store.createSession(body);
    broadcast({ type: "session.changed", sessionId: m.id });
    return c.json(await store.summary(m.id), 201);
  });

  app.post("/api/sessions/register", async (c) => {
    const { dir } = RegisterSession.parse(await c.req.json());
    const m = await store.registerExternal(dir);
    watcher.add(resolve(dir));
    broadcast({ type: "session.changed", sessionId: m.id });
    return c.json(await store.summary(m.id), 201);
  });

  app.get("/api/sessions/:id", async (c) => c.json(await store.summary(c.req.param("id"))));

  app.patch("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const patch = UpdateSession.parse(await c.req.json());
    await store.updateSession(id, patch);
    broadcast({ type: "session.changed", sessionId: id });
    return c.json(await store.summary(id));
  });

  app.delete("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    await store.deleteSession(id);
    broadcast({ type: "session.removed", sessionId: id });
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- pages
  app.get("/api/sessions/:id/pages", async (c) => {
    const id = c.req.param("id");
    const ids = await store.listPageIds(id);
    return c.json(await Promise.all(ids.map((p) => store.getPage(id, p))));
  });

  app.get("/api/sessions/:id/pages/:pageId", async (c) =>
    c.json(await store.getPage(c.req.param("id"), c.req.param("pageId"))),
  );

  app.get("/api/sessions/:id/pages/:pageId/source", async (c) =>
    c.text(await store.readPageSource(c.req.param("id"), c.req.param("pageId"))),
  );

  app.put("/api/sessions/:id/pages/:pageId", async (c) => {
    const id = c.req.param("id");
    const pageId = c.req.param("pageId");
    const { source } = PageBody.parse(await c.req.json());
    await store.writePage(id, pageId, source);
    broadcast({ type: "page.changed", sessionId: id, pageId });
    return c.json(await store.getPage(id, pageId));
  });

  app.delete("/api/sessions/:id/pages/:pageId", async (c) => {
    const id = c.req.param("id");
    const pageId = c.req.param("pageId");
    await store.deletePage(id, pageId);
    broadcast({ type: "page.removed", sessionId: id, pageId });
    return c.json({ ok: true });
  });

  // Assets: anything inside the session dir, read-only, no traversal.
  app.get("/api/sessions/:id/files/*", async (c) => {
    const id = c.req.param("id");
    const rel = decodeURIComponent(c.req.path.split(`/files/`).slice(1).join("/files/"));
    const abs = await store.assetPath(id, rel);
    const file = Bun.file(abs);
    return new Response(file, {
      headers: { "content-type": file.type || "application/octet-stream", "cache-control": "no-cache" },
    });
  });

  // ------------------------------------------------------------- feedback
  app.get("/api/sessions/:id/feedback", async (c) => {
    const id = c.req.param("id");
    const q = FeedbackQuery.parse(c.req.query());
    const items = await store.listFeedback(id, q);
    if (q.format === "md") {
      const summary = await store.summary(id);
      return c.text(formatFeedbackMarkdown(summary, items, { sessionDir: summary.dir }));
    }
    return c.json(items);
  });

  app.post("/api/sessions/:id/feedback", async (c) => {
    const id = c.req.param("id");
    const body = CreateFeedback.parse(await c.req.json());
    const item = await store.createFeedback(id, body);
    broadcast({ type: "feedback.changed", sessionId: id, feedbackId: item.id });
    return c.json(item, 201);
  });

  app.patch("/api/sessions/:id/feedback/:fid", async (c) => {
    const id = c.req.param("id");
    const fid = c.req.param("fid");
    const item = await store.updateFeedback(id, fid, UpdateFeedback.parse(await c.req.json()));
    broadcast({ type: "feedback.changed", sessionId: id, feedbackId: fid });
    return c.json(item);
  });

  app.delete("/api/sessions/:id/feedback/:fid", async (c) => {
    const id = c.req.param("id");
    const fid = c.req.param("fid");
    await store.deleteFeedback(id, fid);
    broadcast({ type: "feedback.changed", sessionId: id, feedbackId: fid });
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/feedback/:fid/replies", async (c) => {
    const id = c.req.param("id");
    const fid = c.req.param("fid");
    const { author, body } = CreateReply.parse(await c.req.json());
    const item = await store.addReply(id, fid, author, body);
    broadcast({ type: "feedback.changed", sessionId: id, feedbackId: fid });
    return c.json(item);
  });

  /** Human pressed "Send to agent". */
  app.post("/api/sessions/:id/send", async (c) => {
    const id = c.req.param("id");
    const result = await store.sendBatch(id);
    broadcast({ type: "feedback.batch", sessionId: id, batch: result.batch });
    broadcast({ type: "session.changed", sessionId: id });
    return c.json(result);
  });

  /**
   * Long-poll for the agent CLI: resolves when a feedback batch is sent (or
   * any feedback changes if `any=1`), or after `timeout` ms with `{timedOut}`.
   */
  app.get("/api/sessions/:id/wait", async (c) => {
    const id = c.req.param("id");
    await store.readManifest(id);
    const any = c.req.query("any") === "1";
    const timeout = Math.min(Number(c.req.query("timeout") ?? 25_000), 120_000);
    const event = await new Promise<LiveEvent | null>((resolvePromise) => {
      const set = waiters.get(id) ?? new Set();
      waiters.set(id, set);
      const timer = setTimeout(() => {
        set.delete(fn);
        resolvePromise(null);
      }, timeout);
      const fn = (e: LiveEvent) => {
        if (e.type === "feedback.batch" || (any && e.type === "feedback.changed")) {
          clearTimeout(timer);
          set.delete(fn);
          resolvePromise(e);
        }
      };
      set.add(fn);
    });
    return c.json({ timedOut: event === null, event });
  });

  // ----------------------------------------------------------------- open
  app.post("/api/open", async (c) => {
    const { sessionId, path } = OpenPathRequest.parse(await c.req.json());
    const m = await store.readManifest(sessionId);
    const roots = [...m.allowedRoots, store.sessionDir(sessionId)];
    return c.json(await openInFileManager(path, roots));
  });

  // ------------------------------------------------------------ websocket
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_evt, ws) {
        const client = { send: (d: string) => ws.send(d) };
        clients.add(client);
        (ws as unknown as { __pp: unknown }).__pp = client;
        ws.send(JSON.stringify({ type: "hello", hostVersion: HOST_VERSION } satisfies LiveEvent));
      },
      onClose(_evt, ws) {
        const client = (ws as unknown as { __pp?: { send: (d: string) => void } }).__pp;
        if (client) clients.delete(client);
      },
    })),
  );

  // -------------------------------------------------------------- static UI
  if (opts.uiDir && existsSync(join(opts.uiDir, "index.html"))) {
    const uiDir = resolve(opts.uiDir);
    app.get("/*", async (c) => {
      const url = new URL(c.req.url);
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const candidate = resolve(uiDir, rel);
      if (rel && candidate.startsWith(uiDir) && existsSync(candidate) && (await Bun.file(candidate).exists())) {
        const f = Bun.file(candidate);
        const immutable = rel.startsWith("assets/");
        return new Response(f, {
          headers: {
            "content-type": f.type || "application/octet-stream",
            "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
          },
        });
      }
      return new Response(Bun.file(join(uiDir, "index.html")), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      });
    });
  } else {
    app.get("/", (c) =>
      c.text(
        "plan-presenter host is running, but no built UI was found.\n" +
          "Run `bun run build` in the repo, or `bun run dev:ui` for the Vite dev server.\n",
      ),
    );
  }

  return {
    app,
    store,
    watcher,
    websocket,
    broadcast,
    stop: async () => {
      await watcher.stop();
      clients.clear();
    },
  };
}
