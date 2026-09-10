import { describe, expect, test } from "bun:test";
import { KNOWN_COMPONENTS } from "@plan-presenter/protocol";
import { compilePage } from "../src/compile.ts";

describe("unknown components", () => {
  test("capitalised JSX names outside the provided set are reported once, with a line", async () => {
    const src = `# Title

<Chart data={[[1],[2]]} />

<Nonexistent foo="bar" />

Inline <Widget /> here, and <Nonexistent /> again.

<div>html is fine</div>
`;
    const r = await compilePage(src, "u.mdx");
    expect(r.error).toBeNull();
    expect(r.unknownComponents).toEqual([
      { name: "Nonexistent", line: 5 },
      { name: "Widget", line: 7 },
    ]);
  });

  test("every provided component is known", async () => {
    const src = KNOWN_COMPONENTS.map((n) => `<${n} />`).join("\n\n");
    const r = await compilePage(src, "k.mdx");
    expect(r.unknownComponents).toEqual([]);
  });
});
