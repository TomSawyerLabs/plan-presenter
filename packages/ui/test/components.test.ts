import { describe, expect, test } from "bun:test";
import { KNOWN_COMPONENTS } from "@plan-presenter/protocol";

/**
 * The host flags any capitalised JSX name not in KNOWN_COMPONENTS, so the UI's
 * component map must provide exactly that set (plus lowercase tag overrides).
 * Imported lazily because the map pulls in uPlot's CSS.
 */
describe("mdx component map", () => {
  test("matches KNOWN_COMPONENTS", async () => {
    const { mdxComponents } = await import("../src/components/mdx/index.ts");
    const provided = Object.keys(mdxComponents)
      .filter((k) => /^[A-Z]/.test(k))
      .sort();
    expect(provided).toEqual([...KNOWN_COMPONENTS].sort());
  });
});
