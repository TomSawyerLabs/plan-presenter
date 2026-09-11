import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkDue } from "../scripts/_autoupdate.ts";
import { healthy, isIdle, pidPath, serve, stop, type Health } from "../scripts/_host.ts";
import { acquireLock } from "../scripts/_lib.ts";

const repo = resolve(import.meta.dir, "../..");
let home: string;
const savedEnv = { PP_HOME: process.env.PP_HOME, PP_URL: process.env.PP_URL };

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "pp-host-"));
  process.env.PP_HOME = home;
  delete process.env.PP_URL;
});

afterAll(async () => {
  await stop();
  rmSync(home, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("lock files", () => {
  test("are exclusive until released", () => {
    const p = join(home, "t.lock");
    const a = acquireLock(p, 60_000);
    expect(a).not.toBeNull();
    expect(acquireLock(p, 60_000)).toBeNull();
    a!.release();
    const b = acquireLock(p, 60_000);
    expect(b).not.toBeNull();
    b!.release();
  });

  test("are taken over when the owner is dead", () => {
    const p = join(home, "dead.lock");
    writeFileSync(p, JSON.stringify({ pid: 2_147_483_000, at: new Date().toISOString() }));
    const l = acquireLock(p, 60_000);
    expect(l).not.toBeNull();
    l!.release();
  });
});

describe("idle detection and check cadence", () => {
  const base: Health = {
    ok: true,
    version: "x",
    pid: 1,
    execPath: "/x",
    activity: { clients: 0, waiters: 0, lastRequestAt: null },
  };
  const activity = base.activity!;

  test("idle only with no viewers, no waiting agents and no recent requests", () => {
    expect(isIdle(base)).toBe(true);
    expect(isIdle({ ...base, activity: { ...activity, clients: 1 } })).toBe(false);
    expect(isIdle({ ...base, activity: { ...activity, waiters: 1 } })).toBe(false);
    expect(
      isIdle({ ...base, activity: { ...activity, lastRequestAt: new Date().toISOString() } }),
    ).toBe(false);
    expect(isIdle({ ...base, activity: undefined })).toBe(false); // pre-0.2 host: unknown means busy
  });

  test("checks every 6 h, retries failures after 1 h and pending restarts after 10 min", () => {
    const t = Date.parse("2026-09-11T12:00:00Z");
    const ago = (ms: number) => new Date(t - ms).toISOString();
    expect(checkDue({}, t)).toBe(true);
    expect(checkDue({ lastCheckAt: ago(5 * 3_600_000), lastCheckOk: true }, t)).toBe(false);
    expect(checkDue({ lastCheckAt: ago(6 * 3_600_000), lastCheckOk: true }, t)).toBe(true);
    expect(checkDue({ lastCheckAt: ago(59 * 60_000), lastCheckOk: false }, t)).toBe(false);
    expect(checkDue({ lastCheckAt: ago(61 * 60_000), lastCheckOk: false }, t)).toBe(true);
    const pending = { from: "1", version: "2", at: ago(0), hostRestart: "pending" as const };
    expect(checkDue({ lastCheckAt: ago(9 * 60_000), installed: pending }, t)).toBe(false);
    expect(checkDue({ lastCheckAt: ago(11 * 60_000), installed: pending }, t)).toBe(true);
  });
});

describe("serve / stop against a real host", () => {
  const port = 20_000 + Math.floor(Math.random() * 20_000);

  test("concurrent serve starts exactly one host; stop stops it", async () => {
    const results = await Promise.all([1, 2, 3].map(() => serve({ repo, port })));
    expect(results.filter((r) => r.started).length).toBe(1);
    const h = await healthy();
    expect(h?.pid).toBe(Number(readFileSync(pidPath(), "utf8")));
    expect(h?.activity).toEqual({ clients: 0, waiters: 0, lastRequestAt: null });
    expect(await stop()).toBe("stopped");
    expect(await healthy()).toBeNull();
    expect(await stop()).toBe("not-running");
  }, 60_000);

  test("stop leaves alone a host it did not start", async () => {
    const r = await serve({ repo, port });
    expect(r.started).toBe(true);
    const real = readFileSync(pidPath(), "utf8");
    writeFileSync(pidPath(), "1"); // e.g. the desktop app's in-process host
    expect(await stop()).toBe("not-ours");
    expect(await healthy()).not.toBeNull();
    writeFileSync(pidPath(), real);
    expect(await stop()).toBe("stopped");
  }, 60_000);
});
