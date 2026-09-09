import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenRefused, resolveAllowed } from "../src/open.ts";

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pp-open-"));
  mkdirSync(join(root, "allowed", "sub"), { recursive: true });
  mkdirSync(join(root, "other"), { recursive: true });
  writeFileSync(join(root, "allowed", "sub", "f.txt"), "x");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("resolveAllowed", () => {
  test("accepts paths inside an allowed root", async () => {
    const p = await resolveAllowed(join(root, "allowed", "sub", "f.txt"), [join(root, "allowed")]);
    expect(p.toLowerCase()).toContain("f.txt");
  });
  test("accepts the root itself", async () => {
    await expect(
      resolveAllowed(join(root, "allowed"), [join(root, "allowed")]),
    ).resolves.toBeTruthy();
  });
  test("refuses siblings, prefix tricks, relative paths and missing paths", async () => {
    await expect(
      resolveAllowed(join(root, "other"), [join(root, "allowed")]),
    ).rejects.toBeInstanceOf(OpenRefused);
    mkdirSync(join(root, "allowed-evil"), { recursive: true });
    await expect(
      resolveAllowed(join(root, "allowed-evil"), [join(root, "allowed")]),
    ).rejects.toBeInstanceOf(OpenRefused);
    await expect(resolveAllowed("relative/path", [root])).rejects.toBeInstanceOf(OpenRefused);
    await expect(
      resolveAllowed(join(root, "allowed", "nope"), [join(root, "allowed")]),
    ).rejects.toBeInstanceOf(OpenRefused);
    await expect(
      resolveAllowed(join(root, "allowed", "..", "other"), [join(root, "allowed")]),
    ).rejects.toBeInstanceOf(OpenRefused);
  });
  test("refuses everything when there are no roots", async () => {
    await expect(resolveAllowed(join(root, "allowed"), [])).rejects.toBeInstanceOf(OpenRefused);
  });
});
