#!/usr/bin/env bun
/**
 * pp - agent CLI for plan-presenter.
 *
 *   pp serve [--lan] [--port N]             ensure the host is running (spawns it detached)
 *   pp stop                                 stop the host started by `pp serve`
 *   pp update [--tag vX.Y.Z]                download the latest prebuilt host binary
 *   pp version                              CLI, binary and running-host versions
 *   pp status [<session>]                   host health / session summary
 *   pp sessions                             list sessions
 *   pp new "<title>" [--id s] [--root DIR]... [--dir DIR]   create a session
 *   pp page <session> <pageId> [--file F]   write a page from a file or stdin
 *   pp open <session>                       open the UI in the host machine's browser
 *   pp review <session> [--open]            mark awaiting-review (asks the human to look)
 *   pp wait <session> [--timeout 9m] [--any] block until the human sends feedback; prints it
 *   pp feedback <session> [--open|--batch N|--since N|--json]   print feedback
 *   pp reply <session> <id> "<text>"        reply to a feedback item (marks it acknowledged)
 *   pp resolve <session> <id>...            mark items resolved
 *   pp close <session>                      close the session
 *   pp rm <session>                         delete (or unregister) a session
 *
 * Host resolution for `pp serve`: a repo checkout recorded in
 * ~/.plan-presenter/config.json (dev), else the prebuilt binary in
 * ~/.plan-presenter/bin, downloaded from GitHub Releases on first use.
 */

import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  api,
  ApiError,
  binaryVersion,
  DEFAULT_PORT,
  downloadHostBinary,
  hostBinaryPath,
  hostUrl,
  lanUrl,
  loadConfig,
  parseArgv,
  parseDuration,
  ppHome,
  saveConfig,
  str,
} from "./_lib.ts";

interface SessionSummary {
  id: string;
  title: string;
  status: string;
  dir: string;
  updatedAt: string;
  allowedRoots: string[];
  pageSummaries: { id: string; title: string; openFeedback: number }[];
  openFeedback: number;
}

const { _: args, flags } = parseArgv(process.argv.slice(2));
const cmd = args[0];

function out(s: string) {
  process.stdout.write(s.endsWith("\n") ? s : s + "\n");
}
function die(msg: string, code = 1): never {
  process.stderr.write(`pp: ${msg}\n`);
  process.exit(code);
}
function need(i: number, what: string): string {
  const v = args[i];
  if (!v) die(`missing ${what}\n\n${usage()}`);
  return v;
}

function usage(): string {
  return readFileSync(new URL(import.meta.url))
    .toString()
    .split("\n")
    .slice(2, 22)
    .map((l) => l.replace(/^ \* ?/, ""))
    .join("\n");
}

async function healthy(): Promise<{ version: string } | null> {
  try {
    return await api<{ version: string }>("/api/health", { timeoutMs: 1500 });
  } catch {
    return null;
  }
}

function pidPath(): string {
  return join(ppHome(), "host.pid");
}

/** How to launch the host: from a repo checkout (dev) or the prebuilt binary. */
async function resolveHostCommand(): Promise<{
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  source: string;
}> {
  const cfg = loadConfig();
  const repoDir = str(flags.repo) ?? cfg.repoDir;
  if (repoDir && existsSync(join(repoDir, "packages", "host", "src", "cli.ts"))) {
    return {
      argv: ["bun", "run", join(repoDir, "packages", "host", "src", "cli.ts")],
      cwd: repoDir,
      env: { PP_UI_DIR: join(repoDir, "packages", "ui", "dist") },
      source: `repo ${repoDir}`,
    };
  }
  const bin = hostBinaryPath();
  if (!existsSync(bin)) {
    out("no host found; downloading the prebuilt host binary…");
    await downloadHostBinary(str(flags.tag) ?? "latest", (s) => process.stderr.write(`${s}\n`));
  }
  return { argv: [bin], source: `binary ${bin}` };
}

async function serve(): Promise<void> {
  const cfg = loadConfig();
  const port = Number(str(flags.port) ?? cfg.port ?? DEFAULT_PORT);
  const bind = flags.lan ? "0.0.0.0" : (str(flags.bind) ?? cfg.bind ?? "127.0.0.1");
  if (await healthy()) {
    out(`host already running at ${hostUrl()}`);
    if (flags.lan)
      out("note: --lan ignored because the host is already running; stop it and re-run to rebind");
    return;
  }
  const launch = await resolveHostCommand();
  mkdirSync(ppHome(), { recursive: true });
  const log = openSync(join(ppHome(), "host.log"), "a");
  const root = cfg.root ?? join(ppHome(), "sessions");
  const proc = Bun.spawn([...launch.argv, "--port", String(port), "--host", bind, "--root", root], {
    cwd: launch.cwd,
    stdout: log,
    stderr: log,
    stdin: "ignore",
    detached: true,
    env: { ...process.env, ...launch.env },
  });
  proc.unref();
  writeFileSync(pidPath(), String(proc.pid));
  saveConfig({ ...cfg, repoDir: str(flags.repo) ?? cfg.repoDir, port, bind, root });
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(100);
    const h = await healthy();
    if (h) {
      out(
        `host ${h.version} started at http://127.0.0.1:${port} from ${launch.source} (pid ${proc.pid}, log ${join(ppHome(), "host.log")})`,
      );
      if (bind === "0.0.0.0") {
        const lan = await lanUrl(port);
        if (lan) out(`LAN: ${lan}`);
      }
      return;
    }
  }
  die(`host did not become healthy; see ${join(ppHome(), "host.log")}`);
}

async function stop(): Promise<void> {
  const p = pidPath();
  if (!existsSync(p)) {
    if (await healthy())
      die("a host is running but was not started by `pp serve`; stop it yourself");
    return out("host not running");
  }
  const pid = Number(readFileSync(p, "utf8").trim());
  try {
    process.kill(pid);
    out(`stopped host (pid ${pid})`);
  } catch (e) {
    out(`host pid ${pid} not running (${(e as Error).message})`);
  }
  rmSync(p, { force: true });
  for (let i = 0; i < 20 && (await healthy()); i++) await Bun.sleep(100);
}

async function ensureHost(): Promise<void> {
  if (!(await healthy())) await serve();
}

function sessionUrl(id: string, pageId?: string): string {
  return `${hostUrl()}/#/s/${encodeURIComponent(id)}${pageId ? `/${encodeURIComponent(pageId)}` : ""}`;
}

function summarise(s: SessionSummary): string {
  const pages = s.pageSummaries
    .map((p) => `  - ${p.id}  "${p.title}"${p.openFeedback ? `  (${p.openFeedback} open)` : ""}`)
    .join("\n");
  return [
    `session ${s.id}  "${s.title}"  status=${s.status}  open feedback=${s.openFeedback}`,
    `dir: ${s.dir}`,
    `url: ${sessionUrl(s.id)}`,
    s.allowedRoots.length
      ? `allowed roots: ${s.allowedRoots.join(", ")}`
      : "allowed roots: (none: Folder links disabled)",
    pages ? `pages:\n${pages}` : "pages: (none yet: write pages/*.mdx)",
  ].join("\n");
}

async function openInBrowser(url: string): Promise<void> {
  const argv =
    process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : process.platform === "darwin"
        ? ["open", url]
        : ["xdg-open", url];
  Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" }).unref();
}

async function main(): Promise<void> {
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
      out(usage());
      return;

    case "serve":
      await serve();
      return;

    case "stop":
      await stop();
      return;

    case "update": {
      const running = await healthy();
      if (running && existsSync(pidPath())) {
        out("stopping the running host first…");
        await stop();
      }
      const bin = await downloadHostBinary(str(flags.tag) ?? "latest", out);
      out(`host binary version: ${(await binaryVersion(bin)) ?? "unknown"}`);
      if (running) {
        out("restarting host…");
        await serve();
      }
      return;
    }

    case "version": {
      const cfg = loadConfig();
      out(`cli: ${resolve(import.meta.dir, "..")}`);
      out(`repo: ${cfg.repoDir ?? "(none)"}`);
      const bin = hostBinaryPath();
      out(
        `binary: ${existsSync(bin) ? `${bin} (${(await binaryVersion(bin)) ?? "?"})` : "(not downloaded)"}`,
      );
      const h = await healthy();
      out(`running host: ${h ? `${h.version} at ${hostUrl()}` : "none"}`);
      return;
    }

    case "status": {
      if (args[1]) {
        const s = await api<SessionSummary>(`/api/sessions/${encodeURIComponent(args[1])}`);
        out(summarise(s));
      } else {
        const h = await healthy();
        out(
          h
            ? `host ${h.version} OK at ${hostUrl()}`
            : `host NOT running (expected ${hostUrl()}). Run: pp serve`,
        );
        if (!h) process.exit(2);
      }
      return;
    }

    case "sessions": {
      await ensureHost();
      const list = await api<SessionSummary[]>("/api/sessions");
      if (flags.json) return out(JSON.stringify(list, null, 2));
      if (!list.length) return out("(no sessions)");
      for (const s of list)
        out(
          `${s.id}  ${s.status.padEnd(15)}  open=${String(s.openFeedback).padEnd(3)}  ${s.title}`,
        );
      return;
    }

    case "new": {
      await ensureHost();
      const title = need(1, "title");
      const roots = ([] as string[])
        .concat(flags.root ? [String(flags.root)] : [])
        .map((r) => resolve(r));
      // Default: allow the current working directory so folder links to the project work.
      if (!roots.length && !flags["no-root"]) roots.push(process.cwd());
      const body = { title, id: str(flags.id), allowedRoots: roots, meta: { cwd: process.cwd() } };
      const dir = str(flags.dir);
      let s: SessionSummary;
      if (dir) {
        // External dir: create the manifest locally, then register.
        const abs = resolve(dir);
        mkdirSync(join(abs, "pages"), { recursive: true });
        mkdirSync(join(abs, "assets"), { recursive: true });
        const id = body.id ?? `s-${Date.now().toString(36)}`;
        const now = new Date().toISOString();
        writeFileSync(
          join(abs, "session.json"),
          JSON.stringify(
            {
              id,
              title,
              status: "drafting",
              createdAt: now,
              updatedAt: now,
              allowedRoots: roots,
              pages: [],
              meta: body.meta,
            },
            null,
            2,
          ) + "\n",
        );
        s = await api<SessionSummary>("/api/sessions/register", {
          method: "POST",
          body: JSON.stringify({ dir: abs }),
        });
      } else {
        s = await api<SessionSummary>("/api/sessions", {
          method: "POST",
          body: JSON.stringify(body),
        });
      }
      out(summarise(s));
      out(
        `\nNext: write ${join(s.dir, "pages", "01-overview.mdx")} then run: pp review ${s.id} --open`,
      );
      return;
    }

    case "page": {
      await ensureHost();
      const id = need(1, "session");
      const pageId = need(2, "pageId");
      const file = str(flags.file);
      const source = file ? readFileSync(file, "utf8") : await Bun.stdin.text();
      await api(`/api/sessions/${encodeURIComponent(id)}/pages/${encodeURIComponent(pageId)}`, {
        method: "PUT",
        body: JSON.stringify({ source }),
      });
      out(`wrote page ${pageId}: ${sessionUrl(id, pageId)}`);
      return;
    }

    case "open": {
      await ensureHost();
      const id = need(1, "session");
      const url = sessionUrl(id, str(flags.page));
      await openInBrowser(url);
      out(url);
      return;
    }

    case "review": {
      await ensureHost();
      const id = need(1, "session");
      const s = await api<SessionSummary>(`/api/sessions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "awaiting-review" }),
      });
      if (flags.open) await openInBrowser(sessionUrl(id));
      out(`session ${id} is awaiting review: ${sessionUrl(id)}`);
      const lan = await lanUrl(Number(loadConfig().port ?? DEFAULT_PORT));
      if (lan && loadConfig().bind === "0.0.0.0") out(`LAN: ${lan}/#/s/${encodeURIComponent(id)}`);
      if (!s.pageSummaries.length) out("warning: session has no pages yet");
      return;
    }

    case "wait": {
      await ensureHost();
      const id = need(1, "session");
      const total = parseDuration(str(flags.timeout), 9 * 60_000);
      const any = !!flags.any;
      const deadline = Date.now() + total;
      const before = await api<SessionSummary>(`/api/sessions/${encodeURIComponent(id)}`);
      process.stderr.write(
        `waiting for feedback on "${before.title}" (${sessionUrl(id)}) up to ${Math.round(total / 1000)}s…\n`,
      );
      while (Date.now() < deadline) {
        const slice = Math.min(25_000, deadline - Date.now());
        const r = await api<{ timedOut: boolean; event: { type: string; batch?: number } | null }>(
          `/api/sessions/${encodeURIComponent(id)}/wait?timeout=${slice}${any ? "&any=1" : ""}`,
          { timeoutMs: slice + 5_000 },
        );
        if (!r.timedOut && r.event) {
          const q =
            r.event.type === "feedback.batch" && r.event.batch
              ? `?batch=${r.event.batch}&format=md`
              : "?format=md";
          out(await api<string>(`/api/sessions/${encodeURIComponent(id)}/feedback${q}`));
          return;
        }
      }
      process.stderr.write(
        "timed out; re-run `pp wait` to keep waiting, or `pp feedback` to see what's there.\n",
      );
      process.exit(3);
    }

    case "feedback": {
      await ensureHost();
      const id = need(1, "session");
      const q = new URLSearchParams();
      if (flags.open) q.set("status", "open");
      if (str(flags.batch)) q.set("batch", String(flags.batch));
      if (str(flags.since)) q.set("since", String(flags.since));
      if (!flags.json) q.set("format", "md");
      const res = await api<unknown>(`/api/sessions/${encodeURIComponent(id)}/feedback?${q}`);
      out(typeof res === "string" ? res : JSON.stringify(res, null, 2));
      return;
    }

    case "reply": {
      await ensureHost();
      const id = need(1, "session");
      const fid = need(2, "feedback id");
      const body = need(3, "text");
      await api(
        `/api/sessions/${encodeURIComponent(id)}/feedback/${encodeURIComponent(fid)}/replies`,
        {
          method: "POST",
          body: JSON.stringify({ author: "agent", body }),
        },
      );
      out(`replied to ${fid}`);
      return;
    }

    case "resolve":
    case "ack": {
      await ensureHost();
      const id = need(1, "session");
      const ids = args.slice(2);
      if (!ids.length) die("missing feedback id(s)");
      const status = cmd === "resolve" ? "resolved" : "acknowledged";
      for (const fid of ids) {
        await api(`/api/sessions/${encodeURIComponent(id)}/feedback/${encodeURIComponent(fid)}`, {
          method: "PATCH",
          body: JSON.stringify({ status }),
        });
        out(`${fid} -> ${status}`);
      }
      return;
    }

    case "close": {
      await ensureHost();
      const id = need(1, "session");
      await api(`/api/sessions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "closed" }),
      });
      out(`closed ${id}`);
      return;
    }

    case "rm": {
      await ensureHost();
      const id = need(1, "session");
      await api(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      out(`removed ${id}`);
      return;
    }

    default:
      die(`unknown command "${cmd}"\n\n${usage()}`);
  }
}

main().catch((e) => {
  if (e instanceof ApiError) die(e.message, e.status === 0 ? 2 : 1);
  die(e instanceof Error ? e.message : String(e));
});
