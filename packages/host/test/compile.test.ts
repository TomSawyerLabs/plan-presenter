import { describe, expect, test } from "bun:test";
import { compilePage, parseFrontmatter } from "../src/compile.ts";

const SRC = `---
title: Smoke
order: 2
---

# Hello

A paragraph with **bold**.

- item one
- item two

\`\`\`mermaid
graph TD; A-->B
\`\`\`

<Chart id="c1" data={[[1,2,3],[4,5,6]]} />

| a | b |
|---|---|
| 1 | 2 |
`;

describe("compilePage", () => {
  test("anchors every block with id, type and line range", async () => {
    const r = await compilePage(SRC, "smoke.mdx");
    expect(r.error).toBeNull();
    expect(r.frontmatter).toEqual({ title: "Smoke", order: 2 });
    const types = r.blocks.map((b) => b.type);
    expect(types).toEqual([
      "heading",
      "paragraph",
      "list",
      "listItem",
      "listItem",
      "code",
      "mdxJsxFlowElement",
      "table",
    ]);
    const heading = r.blocks[0]!;
    expect(heading.line).toEqual({ start: 6, end: 6 });
    expect(heading.excerpt).toBe("Hello");
    expect(r.code).toContain(`"data-pp-block": "${heading.id}"`);
    // JSX elements receive the attributes as props too.
    const chart = r.blocks.find((b) => b.type === "mdxJsxFlowElement")!;
    expect(r.code).toMatch(new RegExp(`Chart[\\s\\S]*"data-pp-block": "${chart.id}"`));
  });

  test("ids are stable across unrelated edits and change when the block changes", async () => {
    const a = await compilePage(SRC, "a.mdx");
    const b = await compilePage(SRC.replace("# Hello", "# Hello there"), "b.mdx");
    const para = (r: typeof a) => r.blocks.find((x) => x.type === "paragraph")!.id;
    const head = (r: typeof a) => r.blocks.find((x) => x.type === "heading")!.id;
    expect(para(a)).toBe(para(b));
    expect(head(a)).not.toBe(head(b));
  });

  test("duplicate blocks get distinct ids", async () => {
    const r = await compilePage("same\n\nsame\n", "d.mdx");
    const ids = r.blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids[1]).toBe(`${ids[0]}-2`);
  });

  test("syntax errors produce an error module instead of throwing", async () => {
    const r = await compilePage("# ok\n\n<Unclosed\n", "bad.mdx");
    expect(r.error).toBeTruthy();
    expect(r.blocks).toEqual([]);
    expect(r.code).toContain("pp-compile-error");
  });
});

describe("parseFrontmatter", () => {
  test("reads yaml frontmatter", () => {
    expect(parseFrontmatter("---\ntitle: X\n---\nbody")).toEqual({ title: "X" });
  });
  test("tolerates missing or broken frontmatter", () => {
    expect(parseFrontmatter("body")).toEqual({});
    expect(parseFrontmatter("---\n: [\n---\n")).toEqual({});
  });
});
