import { describe, expect, test } from "bun:test";
import { compareVersions as skillCompare } from "../../../skill/scripts/_release.ts";
import { VERSION_VECTORS } from "../../../skill/test/version-vectors.ts";
import { compareVersions, isNewer } from "../src/version.ts";

describe("compareVersions", () => {
  test.each(VERSION_VECTORS)("%s vs %s -> %d", (a, b, want) => {
    expect(compareVersions(a, b)).toBe(want);
    expect(compareVersions(b, a)).toBe(-want || 0);
    // The skill carries its own copy (no node_modules there); keep them identical.
    expect(skillCompare(a, b)).toBe(want);
  });

  test("isNewer guards the desktop updater against downgrades", () => {
    expect(isNewer("0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("0.1.0", "0.2.0")).toBe(false);
    expect(isNewer("0.2.0", "0.2.0")).toBe(false);
  });
});
