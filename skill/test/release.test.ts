import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applySkillBundle,
  compareVersions,
  downloadVerified,
  fetchManifest,
  hostBinaryName,
  installHostBinary,
  installedHostVersions,
  isNewer,
  readCurrentHost,
  skillInfo,
  type ReleaseManifest,
} from "../scripts/_release.ts";
import { readTarGz } from "../scripts/_tar.ts";
import { VERSION_VECTORS } from "./version-vectors.ts";

const enc = new TextEncoder();
const repo = resolve(import.meta.dir, "../..");
const sha256 = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

describe("compareVersions", () => {
  test.each(VERSION_VECTORS)("%s vs %s -> %d", (a, b, want) => {
    expect(compareVersions(a, b)).toBe(want);
    expect(compareVersions(b, a)).toBe(-want || 0);
  });
  test("isNewer", () => {
    expect(isNewer("0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "dev")).toBe(true);
  });
});

// A fake GitHub releases endpoint: /latest/download/<f> and /download/<tag>/<f>.
let server: ReturnType<typeof Bun.serve>;
let base: string;
const releases = new Map<string, Map<string, Uint8Array>>();
let latestTag = "";
const hits: string[] = [];

function publish(version: string, files: Record<string, Uint8Array>): ReleaseManifest {
  const tag = `v${version}`;
  const assets: ReleaseManifest["assets"] = {};
  for (const [name, data] of Object.entries(files))
    assets[name] = { sha256: sha256(data), size: data.length };
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
    new Map([...Object.entries(files), ["manifest.json", enc.encode(JSON.stringify(manifest))]]),
  );
  latestTag = tag;
  return manifest;
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      hits.push(path);
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
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

let home: string;
const savedEnv = { PP_HOME: process.env.PP_HOME, PP_RELEASE_BASE: process.env.PP_RELEASE_BASE };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pp-rel-"));
  process.env.PP_HOME = home;
  process.env.PP_RELEASE_BASE = base;
  hits.length = 0;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("downloadVerified", () => {
  test("writes the file when sha256 and size match", async () => {
    const data = enc.encode("host binary bytes");
    publish("1.0.0", { "a.bin": data });
    const dest = join(home, "out", "a.bin");
    await downloadVerified(`${base}/download/v1.0.0/a.bin`, dest, {
      sha256: sha256(data),
      size: data.length,
    });
    expect(readFileSync(dest)).toEqual(Buffer.from(data));
  });

  test("rejects a mismatch and leaves nothing behind", async () => {
    publish("1.0.0", { "a.bin": enc.encode("tampered") });
    const dir = join(home, "out");
    const good = enc.encode("expected");
    await expect(
      downloadVerified(`${base}/download/v1.0.0/a.bin`, join(dir, "a.bin"), {
        sha256: sha256(good),
        size: good.length,
      }),
    ).rejects.toThrow(/checksum mismatch/);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("HTTP errors throw", async () => {
    await expect(downloadVerified(`${base}/nope`, join(home, "x"), null)).rejects.toThrow(
      /HTTP 404/,
    );
  });
});

describe("host binaries", () => {
  const name = hostBinaryName();

  test("installs from the latest manifest, skips re-downloads, prunes to two versions", async () => {
    publish("1.0.0", { [name]: enc.encode("v1") });
    const c1 = await installHostBinary(await fetchManifest());
    expect(c1.version).toBe("1.0.0");
    expect(c1.path).toBe(join(home, "bin", "1.0.0", name));
    expect(readFileSync(c1.path, "utf8")).toBe("v1");

    hits.length = 0;
    await installHostBinary(await fetchManifest());
    expect(hits.filter((h) => h.endsWith(name))).toEqual([]); // already present and verified

    publish("1.1.0", { [name]: enc.encode("v1.1") });
    await installHostBinary(await fetchManifest());
    publish("2.0.0", { [name]: enc.encode("v2") });
    const c3 = await installHostBinary(await fetchManifest());
    expect(readCurrentHost()?.path).toBe(c3.path);
    expect(installedHostVersions().map((v) => v.version)).toEqual(["2.0.0", "1.1.0"]);
  });

  test("a release without this platform's binary is an error", async () => {
    publish("3.0.0", { "pp-host-other": enc.encode("x") });
    await expect(installHostBinary(await fetchManifest())).rejects.toThrow(/has no/);
  });

  test("fetchManifest reports a missing manifest with its status", async () => {
    await expect(fetchManifest("v0.0.1")).rejects.toMatchObject({ status: 404 });
  });
});

describe("skill bundles", () => {
  const entry = (path: string, text: string) => ({ path, data: enc.encode(text), mode: 0o644 });
  const version = (v: string, files: string[]) =>
    entry("version.json", JSON.stringify({ version: v, channel: "release", files }));

  test("skillInfo: missing version.json means a dev install", () => {
    expect(skillInfo(home)).toMatchObject({ version: "dev", channel: "dev" });
    writeFileSync(
      join(home, "version.json"),
      JSON.stringify({ version: "1.2.3", channel: "release", files: ["a"] }),
    );
    expect(skillInfo(home)).toMatchObject({ version: "1.2.3", channel: "release", files: ["a"] });
  });

  test("applies over an install: writes new files, drops files the old version shipped, keeps others", () => {
    const dir = join(home, "skill");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "old");
    writeFileSync(join(dir, "scripts", "pp.ts"), "old");
    writeFileSync(join(dir, "scripts", "gone.ts"), "old");
    writeFileSync(join(dir, "notes.txt"), "user file");
    writeFileSync(
      join(dir, "version.json"),
      JSON.stringify({
        version: "1.0.0",
        channel: "release",
        files: ["SKILL.md", "scripts/pp.ts", "scripts/gone.ts"],
      }),
    );
    const res = applySkillBundle(
      [
        entry("SKILL.md", "new"),
        entry("scripts/pp.ts", "new"),
        entry("scripts/added.ts", "new"),
        version("1.1.0", ["SKILL.md", "scripts/added.ts", "scripts/pp.ts"]),
      ],
      dir,
      "1.1.0",
    );
    expect(res).toEqual({ written: 3, removed: ["scripts/gone.ts"] });
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe("new");
    expect(existsSync(join(dir, "scripts", "gone.ts"))).toBe(false);
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("user file");
    expect(skillInfo(dir).version).toBe("1.1.0");
    expect(readdirSync(join(dir, "scripts")).some((f) => f.endsWith(".pp-new"))).toBe(false);
  });

  test("refuses incomplete or mismatched bundles without touching the install", () => {
    const dir = join(home, "skill2");
    mkdirSync(dir);
    writeFileSync(join(dir, "SKILL.md"), "keep");
    expect(() => applySkillBundle([entry("SKILL.md", "x")], dir)).toThrow(/version.json/);
    expect(() => applySkillBundle([entry("SKILL.md", "x"), version("2.0.0", [])], dir)).toThrow(
      /scripts\/pp.ts/,
    );
    expect(() =>
      applySkillBundle(
        [entry("SKILL.md", "x"), entry("scripts/pp.ts", "x"), version("2.0.0", [])],
        dir,
        "3.0.0",
      ),
    ).toThrow(/expected 3.0.0/);
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe("keep");
  });

  test("package-skill produces a release bundle the updater accepts", () => {
    const out = join(home, "skill.tar.gz");
    const r = Bun.spawnSync(
      [process.execPath, "run", "scripts/package-skill.ts", "--out", out, "--version", "9.9.9"],
      { cwd: repo, stdout: "pipe", stderr: "pipe" },
    );
    expect(r.exitCode).toBe(0);
    const entries = readTarGz(readFileSync(out));
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("SKILL.md");
    expect(paths).toContain("scripts/pp.ts");
    expect(paths).toContain("scripts/_tar.ts");
    expect(paths).not.toContain("scripts/install.ts");
    const vj = JSON.parse(
      new TextDecoder().decode(entries.find((e) => e.path === "version.json")!.data),
    );
    expect(vj.version).toBe("9.9.9");
    expect(vj.channel).toBe("release");
    expect([...vj.files].sort()).toEqual(paths.filter((p) => p !== "version.json").sort());
    const dir = join(home, "installed");
    mkdirSync(dir);
    applySkillBundle(entries, dir, "9.9.9");
    expect(skillInfo(dir)).toMatchObject({ version: "9.9.9", channel: "release" });
  });
});
