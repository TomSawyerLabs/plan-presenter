#!/usr/bin/env bun
/**
 * pp - agent CLI for plan-presenter (usage below; SKILL.md explains the loop).
 *
 * `pp serve` runs the host from the repo checkout recorded by the dev installer,
 * otherwise from the prebuilt binary under ~/.plan-presenter/bin (downloaded
 * from GitHub Releases on first use). Release installs update themselves in the
 * background; see _autoupdate.ts.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  autoUpdateStatus,
  maybeScheduleAutoUpdate,
  readState,
  runAutoUpdate,
  setAutoUpdate,
  takeUpdateNotice,
  updateLogPath,
} from "./_autoupdate.ts";
import { healthy, hostLogPath, installHost, serve, stop } from "./_host.ts";
import {
  api,
  ApiError,
  DEFAULT_PORT,
  hostUrl,
  lanUrl,
  loadConfig,
  parseArgv,
  parseDuration,
  samePath,
  str,
} from "./_lib.ts";
import {
  binaryVersion,
  currentHostBinary,
  fetchManifest,
  installHostBinary,
  installSkillBundle,
  isNewer,
  ManifestUnavailable,
  readCurrentHost,
  skillInfo,
  type CurrentHost,
} from "./_release.ts";

const USAGE = `pp - agent CLI for plan-presenter

  pp serve [--lan] [--port N]              start the host if it isn't running
  pp stop                                  stop the host started by pp serve
  pp status [<session>]                    host health, or a session summary + URL
  pp sessions                              list sessions
  pp new "<title>" [--id x] [--root DIR] [--dir DIR]   create a session
  pp page <session> <pageId> [--file F]    write a page (stdin if no --file)
  pp open <session> [--page P]             open the UI in the host machine's browser
  pp review <session> [--open] [--force]   ask for review (refuses while render errors are open)
  pp wait <session> [--timeout 9m] [--any] block until the human sends feedback; prints it
  pp errors <session> [--all]              render errors (compile/mermaid/chart/asset/...)
  pp feedback <session> [--open|--batch N|--since N|--json]
  pp reply <session> <id> "<text>"         reply to a feedback item (marks it acknowledged)
  pp resolve <session> <id>...             mark items resolved
  pp ack <session> <id>...                 mark items acknowledged
  pp close <session>                       close the session
  pp rm <session>                          delete (or unregister) a session
  pp invite <session> [name ...] [--count N]   mint private review links, one per person
  pp reviewers <session> [--json]          list invited reviewers: name, done?, link
  pp version                               skill, host binary and running host versions
  pp update [--check] [--tag vX.Y.Z]       update now (release installs also update themselves)
  pp auto-update [on|off|status|now]       background self-update for release installs`;

interface ReviewerRecord {
  id: string;
  token: string;
  name?: string;
  createdAt: string;
  lastSeenAt?: string;
  submittedAt?: string;
}

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

function out(s: string): void {
  process.stdout.write(s.endsWith("\n") ? s : `${s}\n`);
}
function note(s: string): void {
  process.stderr.write(`pp: ${s}\n`);
}
function die(msg: string, code = 1): never {
  process.stderr.write(`pp: ${msg}\n`);
  process.exit(code);
}
function need(i: number, what: string): string {
  const v = args[i];
  if (!v) die(`missing ${what}\n\n${USAGE}`);
  return v;
}
function numFlag(name: string): number | undefined {
  const v = str(flags[name]);
  return v === undefined ? undefined : Number(v);
}

/** Start the host if needed; progress goes to stderr so stdout stays parseable. */
async function ensureHost(): Promise<void> {
  const r = await serve({ log: note });
  if (r.started) note(`started host ${r.health.version} at ${r.url} (${r.source})`);
}

/** After a manual update: restart the pp-managed host into the new binary right away. */
async function restartInto(host: CurrentHost): Promise<void> {
  const h = await healthy();
  if (!h || (h.execPath && samePath(h.execPath, host.path))) return;
  const s = await stop(out);
  if (s === "stopped") {
    const r = await serve({ log: out });
    out(`host ${r.health.version} restarted from ${r.source}`);
  } else if (s === "not-ours") {
    out(
      "the running host isn't managed by pp serve (desktop app or manual start); restart it to use the new version",
    );
  } else if (s === "failed") {
    out(`could not stop the running host; see ${hostLogPath()}`);
  }
}

function sessionUrl(id: string, pageId?: string): string {
  return `${hostUrl()}/#/s/${encodeURIComponent(id)}${pageId ? `/${encodeURIComponent(pageId)}` : ""}`;
}

/** An invite link: the token rides in the query so the UI can attach it to every request. */
function reviewerUrl(base: string, id: string, token: string): string {
  return `${base}/?reviewer=${encodeURIComponent(token)}#/s/${encodeURIComponent(id)}`;
}

/** The base a person on another machine should use, when the host is bound to the LAN. */
async function shareBase(): Promise<string | null> {
  const cfg = loadConfig();
  if (cfg.bind !== "0.0.0.0") return null;
  return lanUrl(Number(cfg.port ?? DEFAULT_PORT));
}

function describeReviewer(id: string, r: ReviewerRecord, lan: string | null): string {
  const who = r.name ?? "(no name yet: they will be asked on first visit)";
  const state = r.submittedAt
    ? `done ${r.submittedAt}`
    : r.lastSeenAt
      ? `opened, last seen ${r.lastSeenAt}`
      : "not opened yet";
  const lines = [`${r.id}  ${who}  [${state}]`, `  local: ${reviewerUrl(hostUrl(), id, r.token)}`];
  if (lan) lines.push(`  share: ${reviewerUrl(lan, id, r.token)}`);
  return lines.join("\n");
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

/** Commands that must not trigger (or be interrupted by) background update checks. */
const NO_AUTO_UPDATE = new Set<string | undefined>([
  undefined,
  "help",
  "--help",
  "update",
  "auto-update",
  "__auto-update",
]);

async function main(): Promise<void> {
  if (!NO_AUTO_UPDATE.has(cmd)) {
    maybeScheduleAutoUpdate(import.meta.path);
    const notice = takeUpdateNotice();
    if (notice) note(notice);
  }

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
      out(USAGE);
      return;

    case "serve": {
      const r = await serve({
        port: numFlag("port"),
        bind: flags.lan ? "0.0.0.0" : str(flags.bind),
        repo: str(flags.repo),
        tag: str(flags.tag),
        log: out,
      });
      if (!r.started) {
        out(`host ${r.health.version} already running at ${r.url}`);
        if (flags.lan)
          out(
            "note: --lan ignored because the host is already running; pp stop, then pp serve --lan",
          );
        return;
      }
      out(
        `host ${r.health.version} started at ${r.url} from ${r.source} (pid ${r.pid}, log ${hostLogPath()})`,
      );
      if (loadConfig().bind === "0.0.0.0") {
        const lan = await lanUrl(Number(new URL(r.url).port));
        if (lan) out(`LAN: ${lan}`);
      }
      return;
    }

    case "stop": {
      const r = await stop(out);
      if (r === "not-running") out("host not running");
      else if (r === "not-ours")
        die(
          "the running host was not started by `pp serve` (desktop app or manual start); stop it there",
        );
      else if (r === "failed") die(`could not stop the host; see ${hostLogPath()}`);
      return;
    }

    case "version": {
      const info = skillInfo();
      const cfg = loadConfig();
      out(`skill: ${info.version} (${info.channel}) at ${info.dir}`);
      if (cfg.repoDir) out(`repo: ${cfg.repoDir}`);
      const bin = currentHostBinary();
      const binVersion = bin
        ? (readCurrentHost()?.version ?? (await binaryVersion(bin)) ?? "?")
        : null;
      out(`host binary: ${bin ? `${binVersion} at ${bin}` : "(not installed)"}`);
      const h = await healthy();
      out(
        `running host: ${h ? `${h.version} at ${hostUrl()}${h.execPath ? ` (${h.execPath})` : ""}` : "none"}`,
      );
      const st = readState();
      const check = st.lastCheckAt
        ? `; last check ${st.lastCheckAt}${st.lastCheckOk === false ? ` (failed: ${st.lastError})` : ""}`
        : "";
      out(
        `auto-update: ${autoUpdateStatus(info).reason}${check}${st.latestVersion ? `; latest release ${st.latestVersion}` : ""}`,
      );
      return;
    }

    case "update": {
      const info = skillInfo();
      if (info.channel !== "release") {
        out(
          `dev install (skill ${info.version}); it follows ${loadConfig().repoDir ?? "its checkout"}: ` +
            "git pull && bun install && bun run build",
        );
        return;
      }
      const tag = str(flags.tag);
      let manifest;
      try {
        manifest = await fetchManifest(tag);
      } catch (err) {
        if (!(err instanceof ManifestUnavailable && err.status === 404 && tag)) throw err;
        if (flags.check) return out(`release ${tag} predates update manifests`);
        out(`release ${tag} predates update manifests; installing its host binary only`);
        await restartInto(await installHost(tag, out));
        return;
      }
      out(
        `installed: ${info.version}; ${tag ? "requested" : "latest release"}: ${manifest.version}`,
      );
      if (flags.check) return;
      if (!tag && !isNewer(manifest.version, info.version)) return out("already up to date");
      const host = await installHostBinary(manifest, out);
      const res = await installSkillBundle(manifest, info.dir, out);
      out(
        `skill ${manifest.version} installed (${res.written} files` +
          `${res.removed.length ? `, removed ${res.removed.join(", ")}` : ""})`,
      );
      await restartInto(host);
      return;
    }

    case "auto-update": {
      const sub = args[1] ?? "status";
      if (sub === "on" || sub === "off") {
        setAutoUpdate(sub === "on");
      } else if (sub === "now") {
        const r = await runAutoUpdate({ waitForIdle: false, log: out, force: true });
        out(
          `result: ${r.status}${r.to ? ` ${r.from} -> ${r.to}` : ""}` +
            `${r.restart ? `; host restart: ${r.restart}` : ""}${r.error ? `; ${r.error}` : ""}`,
        );
        return;
      } else if (sub !== "status") {
        die("usage: pp auto-update [on|off|status|now]");
      }
      const st = readState();
      out(`auto-update: ${autoUpdateStatus().reason}`);
      if (st.lastCheckAt) {
        out(
          `last check: ${st.lastCheckAt}${st.lastCheckOk === false ? ` (failed: ${st.lastError})` : ""}`,
        );
      }
      if (st.latestVersion) out(`latest release seen: ${st.latestVersion}`);
      if (st.installed) {
        const i = st.installed;
        out(`last update: ${i.from} -> ${i.version} at ${i.at} (host restart: ${i.hostRestart})`);
      }
      out(`log: ${updateLogPath()}`);
      return;
    }

    case "__auto-update": {
      // Detached background job spawned by maybeScheduleAutoUpdate; output goes to update.log.
      const log = (s: string) =>
        process.stdout.write(`${new Date().toISOString()} [${process.pid}] ${s}\n`);
      try {
        await runAutoUpdate({ waitForIdle: true, log });
      } catch (err) {
        log(`error: ${(err as Error).stack ?? String(err)}`);
      }
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
      for (const s of list) {
        out(
          `${s.id}  ${s.status.padEnd(15)}  open=${String(s.openFeedback).padEnd(3)}  ${s.title}`,
        );
      }
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
      const page = await api<{ error: string | null }>(
        `/api/sessions/${encodeURIComponent(id)}/pages/${encodeURIComponent(pageId)}`,
        { method: "PUT", body: JSON.stringify({ source }) },
      );
      if (page.error) {
        out(`compile error in ${pageId}: ${page.error}`);
        process.exit(4);
      }
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
      await api(`/api/sessions/${encodeURIComponent(id)}`); // compiles pages; see "errors"
      const errors = await api<unknown[]>(
        `/api/sessions/${encodeURIComponent(id)}/feedback?kind=error&status=open`,
      );
      if (errors.length && !flags.force) {
        out(
          await api<string>(
            `/api/sessions/${encodeURIComponent(id)}/feedback?kind=error&status=open&format=md`,
          ),
        );
        die(
          `${errors.length} render error(s) are open; fix them before asking for review (or pass --force)`,
          4,
        );
      }
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
      // Render errors already waiting? Return them right away.
      const openErrors = await api<unknown[]>(
        `/api/sessions/${encodeURIComponent(id)}/feedback?kind=error&status=open`,
      );
      if (openErrors.length) {
        out(
          await api<string>(
            `/api/sessions/${encodeURIComponent(id)}/feedback?kind=error&status=open&format=md`,
          ),
        );
        return;
      }
      process.stderr.write(
        `waiting for feedback on "${before.title}" (${sessionUrl(id)}) up to ${Math.round(total / 1000)}s…\n`,
      );
      let failures = 0;
      while (Date.now() < deadline) {
        const slice = Math.min(25_000, deadline - Date.now());
        let r: {
          timedOut: boolean;
          event: { type: string; batch?: number; reviewer?: { id: string; name?: string } } | null;
        };
        try {
          r = await api(
            `/api/sessions/${encodeURIComponent(id)}/wait?timeout=${slice}${any ? "&any=1" : ""}`,
            { timeoutMs: slice + 5_000 },
          );
          failures = 0;
        } catch (err) {
          // The host went away (crash, or an update restarting it): reconnect and keep waiting.
          if (!(err instanceof ApiError) || err.status !== 0 || ++failures > 5) throw err;
          note(`lost the host; reconnecting (${failures}/5)`);
          await Bun.sleep(1000 * failures);
          try {
            await ensureHost();
          } catch {
            /* retried on the next pass */
          }
          continue;
        }
        if (!r.timedOut && r.event) {
          const who = r.event.reviewer ? (r.event.reviewer.name ?? r.event.reviewer.id) : null;
          if (r.event.type === "reviewer.submitted") {
            out(`Reviewer ${who} marked their review done; nothing new to read from them.`);
            return;
          }
          if (who) note(`batch #${r.event.batch} from reviewer ${who}`);
          const q =
            r.event.type === "render.error"
              ? "?kind=error&status=open&format=md"
              : r.event.type === "feedback.batch" && r.event.batch
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

    case "errors": {
      await ensureHost();
      const id = need(1, "session");
      // Fetching the summary compiles every page, so errors are current even if
      // the file watcher missed a write.
      await api(`/api/sessions/${encodeURIComponent(id)}`);
      const q = flags.all ? "kind=error" : "kind=error&status=open";
      out(await api<string>(`/api/sessions/${encodeURIComponent(id)}/feedback?${q}&format=md`));
      return;
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
        { method: "POST", body: JSON.stringify({ author: "agent", body }) },
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

    case "invite": {
      await ensureHost();
      const id = need(1, "session");
      const names = args.slice(2);
      const count = names.length || Math.max(1, Number(str(flags.count) ?? 1));
      const lan = await shareBase();
      for (let i = 0; i < count; i++) {
        const name = names[i];
        const r = await api<ReviewerRecord>(`/api/sessions/${encodeURIComponent(id)}/reviewers`, {
          method: "POST",
          body: JSON.stringify(name ? { name } : {}),
        });
        out(describeReviewer(id, r, lan));
      }
      if (!lan)
        out(
          "\n(host is bound to localhost; restart with `pp serve --lan` to get a link others can open)",
        );
      return;
    }

    case "reviewers": {
      await ensureHost();
      const id = need(1, "session");
      const list = await api<ReviewerRecord[]>(`/api/sessions/${encodeURIComponent(id)}/reviewers`);
      if (flags.json) return out(JSON.stringify(list, null, 2));
      if (!list.length) return out("(no reviewers invited; see: pp invite)");
      const lan = await shareBase();
      for (const r of list) out(describeReviewer(id, r, lan));
      return;
    }

    default:
      die(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

main().catch((e) => {
  if (e instanceof ApiError) die(e.message, e.status === 0 ? 2 : 1);
  die(e instanceof Error ? e.message : String(e));
});
