#!/usr/bin/env bun
/**
 * End-to-end check of release auto-update against a fake GitHub releases
 * endpoint, using a real compiled host binary and a real release-packaged
 * skill. CI runs it after building the host binaries.
 *
 *   bun run scripts/e2e-autoupdate.ts [--bin packages/host/bin/pp-host-<os>-<arch>]
 *
 * 1. Install skill 0.0.1-e2e (release channel); `pp serve` downloads the host
 *    from the fake release and runs it.
 * 2. Publish 0.0.2-e2e while a viewer is connected: the update installs, but
 *    the host restart is deferred.
 * 3. The viewer leaves; a later pp command schedules the background updater,
 *    which restarts the idle host into 0.0.2-e2e. The agent gets one notice.
 * 4. A tampered 0.0.3-e2e (sha256 mismatch) is refused and changes nothing.
 * 5. `pp stop` stops the updated host.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { samePath } from "../skill/scripts/_lib.ts";
import {
  applySkillBundle,
  hostBinaryName,
  type ReleaseManifest,
} from "../skill/scripts/_release.ts";
import { readTarGz } from "../skill/scripts/_tar.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const repo = resolve(import.meta.dir, "..");
const hostName = hostBinaryName();
const hostBytes = new Uint8Array(
  readFileSync(resolve(arg("bin") ?? join(repo, "packages", "host", "bin", hostName))),
);
const work = mkdtempSync(join(tmpdir(), "pp-e2e-"));
const home = join(work, "home");
const skillDir = join(work, "skills", "plan-presenter");
const port = 20_000 + Math.floor(Math.random() * 20_000);
const sha256 = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
const binFor = (v: string) => join(home, "bin", v, hostName);

// ------------------------------------------------------- fake release server
const releases = new Map<string, Map<string, Uint8Array>>();
let latestTag = "";
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    const latest = /^\/latest\/download\/(.+)$/.exec(path);
    const pinned = /^\/download\/([^/]+)\/(.+)$/.exec(path);
    const [tag, name] = latest
      ? [latestTag, latest[1]!]
      : pinned
        ? [pinned[1]!, pinned[2]!]
        : ["", ""];
    const body = releases.get(tag)?.get(name);
    return body ? new Response(body) : new Response("not found", { status: 404 });
  },
});

function packageSkill(version: string): Uint8Array {
  const out = join(work, `skill-${version}.tar.gz`);
  const r = Bun.spawnSync(
    [
      process.execPath,
      "run",
      join(repo, "scripts", "package-skill.ts"),
      "--out",
      out,
      "--version",
      version,
    ],
    { stdout: "ignore", stderr: "inherit" },
  );
  if (r.exitCode !== 0) throw new Error("package-skill failed");
  return new Uint8Array(readFileSync(out));
}

function publish(version: string, opts: { tamperHost?: boolean } = {}): void {
  const tag = `v${version}`;
  const files: Record<string, Uint8Array> = {
    [hostName]: hostBytes,
    "plan-presenter-skill.tar.gz": packageSkill(version),
  };
  const assets: ReleaseManifest["assets"] = {};
  for (const [name, data] of Object.entries(files))
    assets[name] = { sha256: sha256(data), size: data.length };
  if (opts.tamperHost) {
    const bad = hostBytes.slice();
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff;
    files[hostName] = bad; // served bytes no longer match the manifest
  }
  const manifest: ReleaseManifest = {
    schema: 1,
    name: "plan-presenter",
    version,
    tag,
    publishedAt: new Date().toISOString(),
    assets,
  };
  releases.set(
    tag,
    new Map([
      ...Object.entries(files),
      ["manifest.json", new TextEncoder().encode(JSON.stringify(manifest))],
    ]),
  );
  latestTag = tag;
}

// ------------------------------------------------------------------ helpers
const baseEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env))
  if (v !== undefined && k !== "PP_URL") baseEnv[k] = v;
Object.assign(baseEnv, {
  PP_HOME: home,
  PP_RELEASE_BASE: `http://127.0.0.1:${server.port}`,
  PP_NO_AUTO_UPDATE: "1", // background checks only where a step turns them on
});

function pp(args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync([process.execPath, join(skillDir, "scripts", "pp.ts"), ...args], {
    env: { ...baseEnv, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

async function health(): Promise<{ execPath?: string; version?: string } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return r.ok ? ((await r.json()) as { execPath?: string }) : null;
  } catch {
    return null;
  }
}

const runsFrom = (h: { execPath?: string } | null, path: string) =>
  !!h?.execPath && samePath(h.execPath, path);

function check(cond: unknown, what: string): void {
  if (!cond) throw new Error(`E2E FAILED: ${what}`);
  console.log(`ok - ${what}`);
}

function lastLog(n = 4): string {
  try {
    return readFileSync(join(home, "update.log"), "utf8").trim().split("\n").slice(-n).join("\n  ");
  } catch {
    return "(no update.log)";
  }
}

const skillVersion = () =>
  (JSON.parse(readFileSync(join(skillDir, "version.json"), "utf8")) as { version: string }).version;

// -------------------------------------------------------------------- steps
let ok = false;
try {
  // 1. Fresh release install.
  publish("0.0.1-e2e");
  mkdirSync(skillDir, { recursive: true });
  applySkillBundle(readTarGz(packageSkill("0.0.1-e2e")), skillDir);
  let r = pp(["serve", "--port", String(port)]);
  check(r.code === 0, `pp serve downloads and starts the host\n  ${r.stdout.trim()}`);
  check(runsFrom(await health(), binFor("0.0.1-e2e")), "host runs from bin/0.0.1-e2e");

  // 2. New release while someone is viewing: install now, restart later.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  publish("0.0.2-e2e");
  r = pp(["auto-update", "now"]);
  check(
    /updated 0\.0\.1-e2e -> 0\.0\.2-e2e/.test(r.stdout) && /host restart: pending/.test(r.stdout),
    `update installs; restart deferred while a viewer is connected\n  ${r.stdout.trim().split("\n").pop()}`,
  );
  check(skillVersion() === "0.0.2-e2e", "skill files updated in place");
  check(runsFrom(await health(), binFor("0.0.1-e2e")), "host kept running for the viewer");

  // 3. Viewer leaves; the next pp command schedules the background updater.
  ws.close();
  await Bun.sleep(500);
  const statePath = join(home, "update-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { lastCheckAt?: string };
  state.lastCheckAt = new Date(Date.now() - 3_600_000).toISOString(); // pretend the retry interval passed
  writeFileSync(statePath, JSON.stringify(state));
  r = pp(["status"], { PP_NO_AUTO_UPDATE: "" });
  check(
    /plan-presenter updated 0\.0\.1-e2e -> 0\.0\.2-e2e/.test(r.stderr),
    "agent gets an update notice",
  );
  let switched = false;
  for (const deadline = Date.now() + 90_000; Date.now() < deadline;) {
    if (runsFrom(await health(), binFor("0.0.2-e2e"))) {
      switched = true;
      break;
    }
    await Bun.sleep(500);
  }
  check(switched, `background updater restarted the idle host into 0.0.2-e2e\n  ${lastLog()}`);
  r = pp(["status"]);
  check(!/plan-presenter updated/.test(r.stderr), "the notice is shown only once");

  // Let the background updater release its lock before running another update.
  for (
    const until = Date.now() + 15_000;
    Date.now() < until && existsSync(join(home, "update.lock"));
  ) {
    await Bun.sleep(200);
  }

  // 4. A tampered release is refused.
  publish("0.0.3-e2e", { tamperHost: true });
  r = pp(["auto-update", "now"]);
  check(
    /checksum mismatch/.test(r.stdout),
    `tampered release refused\n  ${r.stdout.trim().split("\n").pop()}`,
  );
  check(skillVersion() === "0.0.2-e2e", "skill unchanged after the refused update");
  check(runsFrom(await health(), binFor("0.0.2-e2e")), "host unchanged after the refused update");

  // 5. Stop.
  r = pp(["stop"]);
  check(r.code === 0 && (await health()) === null, "pp stop stops the updated host");
  ok = true;
  console.log("\nE2E auto-update: all checks passed");
} finally {
  if (!ok) {
    console.log(`\nupdate.log:\n  ${lastLog(40)}`);
    try {
      console.log(`host.log:\n${readFileSync(join(home, "host.log"), "utf8").slice(-3000)}`);
    } catch {
      /* none */
    }
  }
  pp(["stop"]);
  server.stop(true);
  await Bun.sleep(300);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* a binary still locked on Windows; temp dir cleanup is best-effort */
  }
}
process.exit(ok ? 0 : 1);
