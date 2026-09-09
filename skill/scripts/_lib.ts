// Shared helpers for the pp CLI. Dependency-free so the installed skill
// works from ~/.claude/skills without a node_modules.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_PORT = 27411;

export interface PpConfig {
  /** Where the plan-presenter repo lives (to spawn the host). */
  repoDir?: string;
  port?: number;
  /** Bind address for `pp serve` (127.0.0.1 or 0.0.0.0). */
  bind?: string;
  /** Sessions root passed to the host. */
  root?: string;
}

export function ppHome(): string {
  return process.env.PP_HOME ?? join(homedir(), ".plan-presenter");
}

export function configPath(): string {
  return join(ppHome(), "config.json");
}

export function loadConfig(): PpConfig {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as PpConfig;
  } catch {
    return {};
  }
}

export function saveConfig(c: PpConfig): void {
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(c, null, 2) + "\n");
}

export function hostUrl(): string {
  if (process.env.PP_URL) return process.env.PP_URL.replace(/\/$/, "");
  const c = loadConfig();
  return `http://127.0.0.1:${c.port ?? DEFAULT_PORT}`;
}

/** URL a human on another machine would use (best-effort LAN address). */
export async function lanUrl(port: number): Promise<string | null> {
  const { networkInterfaces } = await import("node:os");
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) return `http://${ni.address}:${port}`;
    }
  }
  return null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const url = `${hostUrl()}${path}`;
  const ctl = new AbortController();
  const timer = init.timeoutMs ? setTimeout(() => ctl.abort(), init.timeoutMs) : null;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      signal: ctl.signal,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
  } catch (e) {
    throw new ApiError(`cannot reach plan-presenter host at ${hostUrl()} (${(e as Error).message}). Run: pp serve`, 0);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = JSON.parse(text) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(msg, res.status);
  }
  const ct = res.headers.get("content-type") ?? "";
  return (ct.includes("json") ? JSON.parse(text) : text) as T;
}

export function skillDir(): string {
  return resolve(import.meta.dir, "..");
}

export function parseDuration(s: string | undefined, fallbackMs: number): number {
  if (!s) return fallbackMs;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(s.trim());
  if (!m) throw new Error(`bad duration: ${s}`);
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms":
      return n;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    default:
      return n * 1000;
  }
}

/** Minimal argv parser: flags (--x, --x=v, --x v, -x), positionals. */
export function parseArgv(argv: string[]): { _: string[]; flags: Record<string, string | boolean> } {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      _.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags[key] = next;
          i++;
        } else flags[key] = true;
      }
    } else if (a.startsWith("-") && a.length > 1) {
      flags[a.slice(1)] = true;
    } else _.push(a);
  }
  return { _, flags };
}

export function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}
