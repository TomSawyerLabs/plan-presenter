/**
 * plan-presenter desktop shell (Electrobun, Bun main process).
 *
 * - If a host is already listening on the configured port (e.g. started by
 *   `pp serve`), connect to it. Otherwise start one in-process.
 * - Open a native window on the host URL. Everything else is the web UI.
 * - Check GitHub Releases for a newer version shortly after launch and every
 *   6 hours; download it in the background, then ask before restarting.
 *
 * Env: PP_PORT (default 27411), PP_HOST (127.0.0.1; 0.0.0.0 for LAN),
 *      PP_ROOT (sessions dir), PP_UI_DIR (override built UI location),
 *      PP_NO_AUTO_UPDATE=1 (skip update checks).
 */

import { BrowserWindow, Updater, Utils } from "electrobun/bun";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHost } from "@plan-presenter/host";
import { DEFAULT_PORT, isNewer } from "@plan-presenter/protocol";

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

// ------------------------------------------------------------------ updates
// Electrobun's updater reads `<channel>-<os>-<arch>-update.json` from the
// release.baseUrl baked in at build time (GitHub's latest/download). It
// compares build hashes only, so it would happily "update" to an older
// release; we act only on strictly newer versions, and never restart the app
// without asking. Dev builds are skipped by the updater itself.

const UPDATE_FIRST_CHECK_MS = 15_000;
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const updateLog = join(homedir(), ".plan-presenter", "desktop-update.log");
let updateBusy = false;

function logUpdate(message: string): void {
  try {
    mkdirSync(dirname(updateLog), { recursive: true });
    appendFileSync(updateLog, `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* logging is best-effort */
  }
}

Updater.onStatusChange((entry) => {
  if (entry.status !== "download-progress") logUpdate(`${entry.status}: ${entry.message}`);
});

async function checkForUpdates(): Promise<void> {
  if (process.env.PP_NO_AUTO_UPDATE === "1" || updateBusy) return;
  updateBusy = true;
  try {
    const local = await Updater.getLocalInfo();
    if (local.channel === "dev") return;
    const info = await Updater.checkForUpdate();
    if (info.error) {
      logUpdate(`check failed: ${info.error}`);
      return;
    }
    if (!info.updateAvailable) return;
    if (!isNewer(info.version, local.version)) {
      logUpdate(`ignoring ${info.version}: not newer than the running ${local.version}`);
      return;
    }
    logUpdate(`downloading ${info.version} (running ${local.version})`);
    await Updater.downloadUpdate();
    const ready = Updater.updateInfo();
    if (!ready?.updateReady) {
      logUpdate(`download failed: ${ready?.error || "unknown error"}`);
      return;
    }
    const { response } = await Utils.showMessageBox({
      type: "info",
      title: "plan-presenter update",
      message: `plan-presenter ${info.version} is ready to install.`,
      detail: "Restart now to finish updating. Feedback you've already added is saved.",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) {
      logUpdate(`${info.version} postponed; will ask again at the next check`);
      return;
    }
    logUpdate(`applying ${info.version}`);
    await stop?.();
    await Updater.applyUpdate();
  } catch (err) {
    logUpdate(`update error: ${(err as Error).message}`);
  } finally {
    updateBusy = false;
  }
}

setTimeout(() => void checkForUpdates(), UPDATE_FIRST_CHECK_MS);
setInterval(() => void checkForUpdates(), UPDATE_INTERVAL_MS);
