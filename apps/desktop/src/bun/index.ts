/**
 * plan-presenter desktop shell (Electrobun, Bun main process).
 *
 * - If a host is already listening on the configured port (e.g. started by
 *   `pp serve`), connect to it. Otherwise start one in-process.
 * - Open a native window on the host URL. Everything else is the web UI.
 *
 * Env: PP_PORT (default 27411), PP_HOST (127.0.0.1; 0.0.0.0 for LAN),
 *      PP_ROOT (sessions dir), PP_UI_DIR (override built UI location).
 */

import { BrowserWindow } from "electrobun/bun";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHost } from "@plan-presenter/host";
import { DEFAULT_PORT } from "@plan-presenter/protocol";

const port = Number(process.env.PP_PORT ?? DEFAULT_PORT);
const bind = process.env.PP_HOST ?? "127.0.0.1";
const root = process.env.PP_ROOT ?? join(homedir(), ".plan-presenter", "sessions");
const url = `http://127.0.0.1:${port}`;

function findUiDir(): string | undefined {
  const candidates = [
    process.env.PP_UI_DIR,
    // Inside a built app bundle: views/ui next to the bun entrypoint.
    resolve(import.meta.dir, "../views/ui"),
    resolve(import.meta.dir, "../../views/ui"),
    // Running from the repo (electrobun dev).
    resolve(import.meta.dir, "../../../../packages/ui/dist"),
  ].filter((c): c is string => !!c);
  return candidates.find((c) => existsSync(join(c, "index.html")));
}

async function hostIsUp(): Promise<boolean> {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

let stop: (() => Promise<void>) | null = null;

if (await hostIsUp()) {
  console.log(`plan-presenter: using existing host at ${url}`);
} else {
  const uiDir = findUiDir();
  if (!uiDir)
    console.warn("plan-presenter: built UI not found; run `bun run build` at the repo root");
  const host = await createHost({ root, uiDir });
  const server = Bun.serve({
    port,
    hostname: bind,
    fetch: host.app.fetch,
    websocket: host.websocket,
    idleTimeout: 255,
  });
  stop = async () => {
    await host.stop();
    server.stop(true);
  };
  console.log(`plan-presenter: host started at ${url} (sessions: ${host.store.root})`);
}

const win = new BrowserWindow({
  title: "plan-presenter",
  url,
  frame: { width: 1280, height: 860, x: 120, y: 80 },
});

win.on("close", async () => {
  await stop?.();
  process.exit(0);
});
