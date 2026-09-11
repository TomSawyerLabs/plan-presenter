import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTar, readTarGz, safeArchivePath, writeTar, writeTarGz } from "../scripts/_tar.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

const LONG_DIR = `reference/${"deeply-nested-directory-name/".repeat(4)}`;
const LONG_PATH = `${LONG_DIR}a-file-with-a-fairly-long-name-too.md`;

describe("tar writer + reader", () => {
  test("round-trips files, including a path longer than 100 bytes and an empty file", () => {
    const files = [
      { path: "SKILL.md", data: enc.encode("# skill\n") },
      { path: "scripts/pp.ts", data: enc.encode("x".repeat(1500)) },
      { path: "empty.txt", data: new Uint8Array(0) },
      { path: LONG_PATH, data: enc.encode("long") },
    ];
    expect(LONG_PATH.length).toBeGreaterThan(100);
    const out = readTarGz(writeTarGz(files));
    expect(out.map((e) => e.path)).toEqual(files.map((f) => f.path));
    expect(out.map((e) => dec.decode(e.data))).toEqual(files.map((f) => dec.decode(f.data)));
    expect(out[0]!.mode).toBe(0o644);
  });

  test("output is reproducible", () => {
    const files = [{ path: "a.txt", data: enc.encode("same") }];
    expect(writeTarGz(files)).toEqual(writeTarGz(files));
  });

  test("rejects a corrupted header", () => {
    const tar = writeTar([{ path: "a.txt", data: enc.encode("hi") }]);
    tar[0] = 0x7a; // change the name without fixing the checksum
    expect(() => readTar(tar)).toThrow(/checksum/);
  });

  test("rejects paths that escape the target directory", () => {
    for (const bad of ["../evil", "a/../../evil", "/etc/passwd", "C:/Windows/x"]) {
      expect(() => readTar(writeTar([{ path: bad, data: enc.encode("x") }]))).toThrow(/unsafe/);
    }
    expect(safeArchivePath("./scripts//pp.ts")).toBe("scripts/pp.ts");
  });
});

describe("reader against the system tar", () => {
  let dir: string;
  let hasTar = false;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pp-tar-"));
    const src = join(dir, "src");
    mkdirSync(join(src, LONG_DIR), { recursive: true });
    mkdirSync(join(src, "scripts"), { recursive: true });
    writeFileSync(join(src, "SKILL.md"), "# from system tar\n");
    writeFileSync(join(src, "scripts", "pp.ts"), "console.log(1)\n");
    writeFileSync(join(src, LONG_PATH), "long via system tar\n");
    // Relative paths only: GNU tar reads "C:..." as a remote host.
    const r = Bun.spawnSync(["tar", "-czf", "../out.tar.gz", "SKILL.md", "scripts", "reference"], {
      cwd: src,
      stdout: "ignore",
      stderr: "ignore",
    });
    hasTar = r.exitCode === 0;
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("reads GNU/bsdtar output (long names via 'L' or pax headers)", () => {
    if (!hasTar) {
      console.warn("system tar not available; skipping");
      return;
    }
    const out = readTarGz(readFileSync(join(dir, "out.tar.gz")));
    const byPath = new Map(out.map((e) => [e.path, dec.decode(e.data)]));
    expect(byPath.get("SKILL.md")).toBe("# from system tar\n");
    expect(byPath.get("scripts/pp.ts")).toBe("console.log(1)\n");
    expect(byPath.get(LONG_PATH)).toBe("long via system tar\n");
  });
});
