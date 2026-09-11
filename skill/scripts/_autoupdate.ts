// Background self-update for release installs (skill + host binary).
//
// Every pp command calls maybeScheduleAutoUpdate(): a local file read, never
// the network. When a check is due it spawns a detached `pp __auto-update` and
// carries on. That process reads the release manifest, installs a newer host
// binary and skill bundle (sha256-verified), then restarts the running host
// into the new binary once nobody is using it: no UI connected, no `pp wait`
// in flight, no recent API traffic.

import { closeSync, existsSync, mkdirSync, openSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import {
  acquireLock,
  loadConfig,
  pidAlive,
  ppHome,
  readJson,
  samePath,
  saveConfig,
  writeJsonAtomic,
} from "./_lib.ts";
import { healthy, isIdle, runsFromManagedBinary, serve, startedByPp, stop } from "./_host.ts";
import {
  currentHostBinary,
  fetchManifest,
  installHostBinary,
  installSkillBundle,
  isNewer,
  skillInfo,
  type SkillInfo,
} from "./_release.ts";

export const CHECK_INTERVAL_MS = 6 * 3_600_000;
const RETRY_AFTER_FAILURE_MS = 3_600_000;
const RETRY_PENDING_RESTART_MS = 10 * 60_000;
const IDLE_POLL_MS = 10_000;
const IDLE_WAIT_MAX_MS = 60 * 60_000;

/**
 * done: the host now runs the new binary. pending: it was busy; retried later.
 * manual: a pre-0.2 host can't report activity, so a person/agent restarts it.
 * none: nothing to restart (no host running, or not one pp manages).
 */
export type RestartOutcome = "done" | "pending" | "manual" | "none";

export interface UpdateState {
  lastCheckAt?: string;
  lastCheckOk?: boolean;
  lastError?: string | null;
  latestVersion?: string;
  installed?: { from: string; version: string; at: string; hostRestart: RestartOutcome };
  announcedVersion?: string;
}

export function statePath(): string {
  return join(ppHome(), "update-state.json");
}

export function updateLogPath(): string {
  return join(ppHome(), "update.log");
}

function lockPath(): string {
  return join(ppHome(), "update.lock");
}

export function readState(): UpdateState {
  return readJson<UpdateState>(statePath()) ?? {};
}

function patchState(patch: Partial<UpdateState>): UpdateState {
  const next = { ...readState(), ...patch };
  writeJsonAtomic(statePath(), next);
  return next;
}

function now(): string {
  return new Date().toISOString();
}

export function autoUpdateStatus(info: SkillInfo = skillInfo()): {
  enabled: boolean;
  reason: string;
} {
  if (info.channel !== "release")
    return { enabled: false, reason: "dev install (follows its checkout)" };
  if (process.env.PP_NO_AUTO_UPDATE === "1")
    return { enabled: false, reason: "PP_NO_AUTO_UPDATE=1" };
  if (loadConfig().autoUpdate === false)
    return { enabled: false, reason: "turned off (pp auto-update on)" };
  return { enabled: true, reason: "on" };
}

export function setAutoUpdate(on: boolean): void {
  saveConfig({ ...loadConfig(), autoUpdate: on });
}

function updaterRunning(): boolean {
  const owner = readJson<{ pid?: number }>(lockPath());
  return owner?.pid !== undefined && pidAlive(owner.pid);
}

export function checkDue(state: UpdateState = readState(), at = Date.now()): boolean {
  const last = state.lastCheckAt ? Date.parse(state.lastCheckAt) : 0;
  const interval =
    state.installed?.hostRestart === "pending"
      ? RETRY_PENDING_RESTART_MS
      : state.lastCheckOk === false
        ? RETRY_AFTER_FAILURE_MS
        : CHECK_INTERVAL_MS;
  return at - last >= interval;
}

/** Cheap: a state-file read, plus a detached spawn when a check is due. Never throws. */
export function maybeScheduleAutoUpdate(ppScript: string): boolean {
  try {
    if (!autoUpdateStatus().enabled) return false;
    if (!checkDue() || updaterRunning()) return false;
    // Record the attempt first so a burst of pp commands spawns one updater.
    patchState({ lastCheckAt: now() });
    mkdirSync(ppHome(), { recursive: true });
    const log = updateLogPath();
    if (existsSync(log) && statSync(log).size > 1_000_000) truncateSync(log, 0);
    const fd = openSync(log, "a");
    const proc = Bun.spawn([process.execPath, ppScript, "__auto-update"], {
      stdout: fd,
      stderr: fd,
      stdin: "ignore",
      detached: true,
      env: { ...process.env },
    });
    proc.unref();
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/** Restart the pp-managed host into `target` once it is idle (or report why not). */
export async function restartHostWhenIdle(
  target: string,
  opts: { waitForIdle: boolean; log: (s: string) => void },
): Promise<RestartOutcome> {
  const deadline = Date.now() + (opts.waitForIdle ? IDLE_WAIT_MAX_MS : 0);
  let announced = false;
  for (;;) {
    const h = await healthy();
    if (!h) return "none";
    if (h.pid === undefined || h.execPath === undefined || !h.activity) return "manual";
    if (!startedByPp(h) || !runsFromManagedBinary(h)) return "none";
    if (samePath(h.execPath, target)) return "done";
    if (isIdle(h)) {
      opts.log(`host ${h.version} is idle; restarting into ${target}`);
      const stopped = await stop(opts.log);
      if (stopped !== "stopped") {
        opts.log(`could not stop the host (${stopped}); will retry`);
        return "pending";
      }
      try {
        const s = await serve({ log: opts.log });
        opts.log(`host ${s.health.version} running from ${s.health.execPath ?? "?"}`);
        return "done";
      } catch (err) {
        opts.log(`restart failed: ${(err as Error).message}`);
        return "pending";
      }
    }
    if (Date.now() >= deadline) return "pending";
    if (!announced) {
      opts.log(
        `host busy (${h.activity.clients} viewer(s), ${h.activity.waiters} waiting agent(s)); ` +
          "restarting when idle",
      );
      announced = true;
    }
    await Bun.sleep(IDLE_POLL_MS);
  }
}

export interface AutoUpdateResult {
  status: "busy" | "disabled" | "current" | "updated" | "failed";
  from?: string;
  to?: string;
  restart?: RestartOutcome;
  error?: string;
}

/**
 * The update job. `waitForIdle` keeps polling for up to an hour for the host
 * to go idle (background runs); `force` ignores the on/off setting but never
 * touches a dev install.
 */
export async function runAutoUpdate(opts: {
  waitForIdle: boolean;
  log: (s: string) => void;
  force?: boolean;
}): Promise<AutoUpdateResult> {
  const { log } = opts;
  const info = skillInfo();
  const status = autoUpdateStatus(info);
  if (info.channel !== "release" || (!status.enabled && !opts.force)) {
    log(`auto-update skipped: ${status.reason}`);
    return { status: "disabled" };
  }
  const lock = acquireLock(lockPath(), 2 * IDLE_WAIT_MAX_MS);
  if (!lock) {
    log("another updater is already running");
    return { status: "busy" };
  }
  try {
    let manifest;
    try {
      manifest = await fetchManifest();
    } catch (err) {
      const error = (err as Error).message;
      patchState({ lastCheckAt: now(), lastCheckOk: false, lastError: error });
      log(`check failed: ${error}`);
      return { status: "failed", error };
    }
    patchState({
      lastCheckAt: now(),
      lastCheckOk: true,
      lastError: null,
      latestVersion: manifest.version,
    });

    if (!isNewer(manifest.version, info.version)) {
      log(`up to date (${info.version}; latest release ${manifest.version})`);
      // An earlier update may still be waiting for the host to go idle.
      const target = currentHostBinary();
      const restart = target ? await restartHostWhenIdle(target, opts) : "none";
      const inst = readState().installed;
      if (inst?.hostRestart === "pending")
        patchState({ installed: { ...inst, hostRestart: restart } });
      return { status: "current", restart };
    }

    log(`updating ${info.version} -> ${manifest.version}`);
    const at = now();
    try {
      // Host first: the new skill scripts may rely on the new host.
      const host = await installHostBinary(manifest, log);
      const res = await installSkillBundle(manifest, info.dir, log);
      log(
        `skill ${manifest.version}: ${res.written} files written` +
          (res.removed.length ? `, removed ${res.removed.join(", ")}` : ""),
      );
      const installed = { from: info.version, version: manifest.version, at };
      patchState({ installed: { ...installed, hostRestart: "pending" } });
      const restart = await restartHostWhenIdle(host.path, opts);
      patchState({ installed: { ...installed, hostRestart: restart } });
      log(`update to ${manifest.version} complete; host restart: ${restart}`);
      return { status: "updated", from: info.version, to: manifest.version, restart };
    } catch (err) {
      const error = (err as Error).message;
      patchState({ lastCheckOk: false, lastError: error });
      log(`update failed: ${error}`);
      return { status: "failed", error };
    }
  } finally {
    lock.release();
  }
}

/** A one-time line for the agent after an update landed. */
export function takeUpdateNotice(): string | null {
  try {
    const st = readState();
    const inst = st.installed;
    if (!inst || st.announcedVersion === inst.version) return null;
    patchState({ announcedVersion: inst.version });
    const tail =
      inst.hostRestart === "manual"
        ? " Restart the host to finish: pp stop && pp serve."
        : inst.hostRestart === "pending"
          ? " The host switches over once nobody is using it."
          : "";
    return `plan-presenter updated ${inst.from} -> ${inst.version}; re-read SKILL.md for changes.${tail}`;
  } catch {
    return null;
  }
}
