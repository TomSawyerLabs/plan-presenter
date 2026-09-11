// Probing, starting and stopping the one host per machine.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  acquireLock,
  api,
  DEFAULT_PORT,
  isInsideDir,
  loadConfig,
  ppHome,
  saveConfig,
} from "./_lib.ts";
import {
  currentHostBinary,
  fetchManifest,
  installHostBinary,
  installHostBinaryUnverified,
  ManifestUnavailable,
  previousHostBinary,
  setCurrentHost,
  type CurrentHost,
} from "./_release.ts";

export interface HostActivity {
  /** Connected UI WebSockets. */
  clients: number;
  /** In-flight `pp wait` long-polls. */
  waiters: number;
  /** Last API request other than /api/health. */
  lastRequestAt: string | null;
}

export interface Health {
  ok: boolean;
  version: string;
  root?: string;
  // The fields below were added in 0.2.0; older hosts omit them.
  pid?: number;
  execPath?: string;
  startedAt?: string;
  activity?: HostActivity;
}

export async function healthy(url?: string, timeoutMs = 1500): Promise<Health | null> {
  try {
    if (url) {
      const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
      return r.ok ? ((await r.json()) as Health) : null;
    }
    return await api<Health>("/api/health", { timeoutMs });
  } catch {
    return null;
  }
}

export function pidPath(): string {
  return join(ppHome(), "host.pid");
}

export function hostLogPath(): string {
  return join(ppHome(), "host.log");
}

function pidFromFile(): number | null {
  if (!existsSync(pidPath())) return null;
  const n = Number(readFileSync(pidPath(), "utf8").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The live host is the one `pp serve` started (and not, say, the desktop app's). */
export function startedByPp(h: Health): boolean {
  return h.pid !== undefined && pidFromFile() === h.pid;
}

export function runsFromManagedBinary(h: Health): boolean {
  return !!h.execPath && isInsideDir(join(ppHome(), "bin"), h.execPath);
}

/** No UI connected, no `pp wait` in flight, and no API traffic for `quietMs`. */
export function isIdle(h: Health, quietMs = 30_000): boolean {
  const a = h.activity;
  if (!a) return false;
  const last = a.lastRequestAt ? Date.parse(a.lastRequestAt) : 0;
  return a.clients === 0 && a.waiters === 0 && Date.now() - last > quietMs;
}

/** Install the host binary from the latest (or given) release, sha256-verified when possible. */
export async function installHost(
  tag: string | undefined,
  log: (s: string) => void = () => {},
): Promise<CurrentHost> {
  try {
    return await installHostBinary(await fetchManifest(tag), log);
  } catch (err) {
    if (err instanceof ManifestUnavailable && err.status === 404) {
      return installHostBinaryUnverified(tag ?? "latest", log);
    }
    throw err;
  }
}

export interface ServeOptions {
  port?: number;
  bind?: string;
  repo?: string;
  tag?: string;
  log?: (s: string) => void;
}

export interface ServeResult {
  started: boolean;
  health: Health;
  url: string;
  pid?: number;
  source?: string;
}

interface Launch {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  source: string;
  binary: string | null;
}

async function resolveLaunch(opts: ServeOptions, log: (s: string) => void): Promise<Launch> {
  const repoDir = opts.repo ?? loadConfig().repoDir;
  if (repoDir && existsSync(join(repoDir, "packages", "host", "src", "cli.ts"))) {
    return {
      argv: [process.execPath, "run", join(repoDir, "packages", "host", "src", "cli.ts")],
      cwd: repoDir,
      env: { PP_UI_DIR: join(repoDir, "packages", "ui", "dist") },
      source: `repo ${repoDir}`,
      binary: null,
    };
  }
  let bin = currentHostBinary();
  if (!bin) {
    log("no host installed yet; downloading the prebuilt host binary");
    bin = (await installHost(opts.tag, log)).path;
  }
  return { argv: [bin], source: `binary ${bin}`, binary: bin };
}

async function spawnAndWait(
  launch: Launch,
  a: { port: number; bind: string; root: string; url: string },
): Promise<{ health: Health | null; pid: number }> {
  const logFd = openSync(hostLogPath(), "a");
  const proc = Bun.spawn(
    [...launch.argv, "--port", String(a.port), "--host", a.bind, "--root", a.root],
    {
      cwd: launch.cwd,
      stdout: logFd,
      stderr: logFd,
      stdin: "ignore",
      detached: true,
      env: { ...process.env, ...launch.env },
    },
  );
  proc.unref();
  closeSync(logFd);
  writeFileSync(pidPath(), String(proc.pid));
  for (let i = 0; i < 100; i++) {
    await Bun.sleep(100);
    const h = await healthy(a.url);
    if (h) return { health: h, pid: proc.pid };
    if (proc.exitCode !== null) break;
  }
  return { health: null, pid: proc.pid };
}

/**
 * Start the host unless one already answers. Concurrent `pp` processes are
 * serialised with a lock, so only one of them spawns; the rest wait for it.
 * A binary that fails to start is rolled back to the previous version.
 */
export async function serve(opts: ServeOptions = {}): Promise<ServeResult> {
  const log = opts.log ?? (() => {});
  const cfg = loadConfig();
  const port = opts.port ?? cfg.port ?? DEFAULT_PORT;
  const bind = opts.bind ?? cfg.bind ?? "127.0.0.1";
  const url = process.env.PP_URL?.replace(/\/$/, "") ?? `http://127.0.0.1:${port}`;
  const existing = await healthy(url);
  if (existing) return { started: false, health: existing, url };

  mkdirSync(ppHome(), { recursive: true });
  const lock = acquireLock(join(ppHome(), "serve.lock"), 60_000);
  if (!lock) {
    for (let i = 0; i < 200; i++) {
      await Bun.sleep(100);
      const h = await healthy(url);
      if (h) return { started: false, health: h, url };
    }
    throw new Error(
      `another pp process is starting the host but it never answered; see ${hostLogPath()}`,
    );
  }
  try {
    const again = await healthy(url);
    if (again) return { started: false, health: again, url };
    const root = cfg.root ?? join(ppHome(), "sessions");
    saveConfig({ ...cfg, repoDir: opts.repo ?? cfg.repoDir, port, bind, root });
    const launch = await resolveLaunch(opts, log);
    const first = await spawnAndWait(launch, { port, bind, root, url });
    if (first.health) {
      return { started: true, health: first.health, url, pid: first.pid, source: launch.source };
    }
    if (launch.binary) {
      const prev = previousHostBinary(launch.binary);
      if (prev) {
        log(`host from ${launch.binary} did not start; rolling back to ${prev.path}`);
        setCurrentHost(prev.version, prev.path);
        const second = await spawnAndWait(
          { argv: [prev.path], source: `binary ${prev.path}`, binary: prev.path },
          { port, bind, root, url },
        );
        if (second.health) {
          const source = `binary ${prev.path} (rolled back)`;
          return { started: true, health: second.health, url, pid: second.pid, source };
        }
      }
    }
    throw new Error(`host did not become healthy; see ${hostLogPath()}`);
  } finally {
    lock.release();
  }
}

export type StopResult = "stopped" | "not-running" | "not-ours" | "failed";

/**
 * Stop the host `pp serve` started. A live host whose pid differs from our pid
 * file (the desktop app's in-process host, a manual start) is left alone, and
 * nothing is killed when no host answers, so a stale pid file can never take
 * down an unrelated process that reused the pid.
 */
export async function stop(log: (s: string) => void = () => {}): Promise<StopResult> {
  const h = await healthy();
  const pid = pidFromFile();
  if (!h) {
    rmSync(pidPath(), { force: true });
    return "not-running";
  }
  // 0.1.0 hosts don't report a pid; for them the pid file is all we have.
  if (pid === null || (h.pid !== undefined && h.pid !== pid)) return "not-ours";
  try {
    process.kill(pid);
    log(`stopped host (pid ${pid})`);
  } catch (err) {
    log(`could not stop host pid ${pid}: ${(err as Error).message}`);
    return "failed";
  }
  for (let i = 0; i < 50 && (await healthy()); i++) await Bun.sleep(100);
  if (await healthy()) return "failed";
  rmSync(pidPath(), { force: true });
  return "stopped";
}
