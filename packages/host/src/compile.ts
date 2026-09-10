/**
 * MDX compilation with block anchoring.
 *
 * Every block-level mdast node gets `data-pp-block`, `data-pp-type` and
 * `data-pp-line` attributes so the UI can map a click anywhere in the rendered
 * page back to a stable id and a source line range. The list of blocks is
 * returned alongside the compiled code so the sidebar can show them and the
 * agent can locate feedback in the source.
 */

import { compile } from "@mdx-js/mdx";
import type { Root, Content, Parent } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdxFrontmatter from "remark-mdx-frontmatter";
import { visit } from "unist-util-visit";
import { parse as parseYaml } from "yaml";
import {
  BLOCK_ATTR,
  BLOCK_LINE_ATTR,
  BLOCK_TYPE_ATTR,
  BlockIdAllocator,
  KNOWN_COMPONENTS,
  normaliseExcerpt,
  type BlockInfo,
  type PageFrontmatter,
} from "@plan-presenter/protocol";

/** mdast node types that become commentable blocks. */
const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "list",
  "listItem",
  "code",
  "blockquote",
  "table",
  "thematicBreak",
  "html",
  "mdxJsxFlowElement",
  "mdxFlowExpression",
]);

/** Containers whose children are themselves blocks; we still anchor the container. */
interface MdxJsxAttribute {
  type: "mdxJsxAttribute";
  name: string;
  value: string;
}

export interface UnknownComponent {
  name: string;
  line: number;
}

export interface CompileResult {
  code: string;
  blocks: BlockInfo[];
  frontmatter: PageFrontmatter;
  error: string | null;
  hash: string;
  /** Capitalised JSX names that are not provided components (first use each). */
  unknownComponents: UnknownComponent[];
}

const KNOWN = new Set<string>(KNOWN_COMPONENTS);

/** Collect JSX element names that the UI does not provide (lowercase = HTML). */
function remarkUnknownComponents(collector: UnknownComponent[]) {
  return () => (tree: Root) => {
    const seen = new Set<string>();
    visit(tree, (node) => {
      if (node.type !== "mdxJsxFlowElement" && node.type !== "mdxJsxTextElement") return;
      const name = (node as unknown as { name?: string | null }).name;
      if (!name || !/^[A-Z]/.test(name) || KNOWN.has(name) || seen.has(name)) return;
      seen.add(name);
      collector.push({ name, line: node.position?.start.line ?? 0 });
    });
  };
}

function remarkPpBlocks(collector: BlockInfo[]) {
  return () => (tree: Root) => {
    const ids = new BlockIdAllocator();
    visit(tree, (node, _index, parent) => {
      if (!BLOCK_TYPES.has(node.type)) return;
      // Skip nested paragraphs inside tight list items; the listItem is the anchor.
      if (node.type === "paragraph" && parent && (parent as Parent).type === "listItem") return;
      // Skip the root-level frontmatter yaml node's sibling artefacts.
      const start = node.position?.start.line ?? 0;
      const end = node.position?.end.line ?? start;
      const excerptSource = excerptFor(node as Content);
      const id = ids.next(node.type, excerptSource);
      const info: BlockInfo = {
        id,
        type: node.type,
        line: { start, end },
        excerpt: normaliseExcerpt(excerptSource),
      };
      collector.push(info);

      if (node.type === "mdxJsxFlowElement") {
        const el = node as unknown as { attributes: MdxJsxAttribute[] };
        el.attributes ??= [];
        el.attributes.push(
          { type: "mdxJsxAttribute", name: BLOCK_ATTR, value: id },
          { type: "mdxJsxAttribute", name: BLOCK_TYPE_ATTR, value: node.type },
          { type: "mdxJsxAttribute", name: BLOCK_LINE_ATTR, value: `${start}-${end}` },
        );
      } else if (node.type !== "mdxFlowExpression") {
        const data = ((node as { data?: Record<string, unknown> }).data ??= {});
        const h = ((data.hProperties as Record<string, unknown> | undefined) ??= {});
        h[BLOCK_ATTR] = id;
        h[BLOCK_TYPE_ATTR] = node.type;
        h[BLOCK_LINE_ATTR] = `${start}-${end}`;
        data.hProperties = h;
      }
    });
  };
}

function excerptFor(node: Content): string {
  switch (node.type) {
    case "code":
      return `${node.lang ?? ""} ${node.value}`;
    case "thematicBreak":
      return "---";
    case "mdxJsxFlowElement": {
      const el = node as unknown as { name?: string; attributes?: MdxJsxAttribute[] };
      const attrs = (el.attributes ?? [])
        .filter((a) => a.type === "mdxJsxAttribute" && typeof a.value === "string")
        .map((a) => `${a.name}=${a.value}`)
        .join(" ");
      return `<${el.name ?? "fragment"} ${attrs}> ${mdastToString(node)}`;
    }
    case "mdxFlowExpression":
      return `{${(node as unknown as { value: string }).value}}`;
    default:
      return mdastToString(node);
  }
}

export function parseFrontmatter(source: string): PageFrontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!m) return {};
  try {
    const fm = parseYaml(m[1] ?? "");
    return fm && typeof fm === "object" ? (fm as PageFrontmatter) : {};
  } catch {
    return {};
  }
}

export function hashSource(source: string): string {
  return Bun.hash(source).toString(16);
}

export async function compilePage(source: string, filename: string): Promise<CompileResult> {
  const blocks: BlockInfo[] = [];
  const unknownComponents: UnknownComponent[] = [];
  const frontmatter = parseFrontmatter(source);
  const hash = hashSource(source);
  try {
    const file = await compile(
      { value: source, path: filename },
      {
        outputFormat: "function-body",
        development: false,
        providerImportSource: "#",
        remarkPlugins: [
          remarkFrontmatter,
          [remarkMdxFrontmatter, { name: "frontmatter" }],
          remarkGfm,
          remarkPpBlocks(blocks),
          remarkUnknownComponents(unknownComponents),
        ],
      },
    );
    return { code: String(file), blocks, frontmatter, error: null, hash, unknownComponents };
  } catch (err) {
    const message = formatCompileError(err);
    return {
      code: errorModule(message),
      blocks: [],
      unknownComponents: [],
      frontmatter,
      error: message,
      hash,
    };
  }
}

function formatCompileError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { message?: string; line?: number; column?: number; reason?: string };
    const where = e.line ? ` (line ${e.line}${e.column ? `:${e.column}` : ""})` : "";
    return `${e.reason ?? e.message ?? String(err)}${where}`;
  }
  return String(err);
}

/** A tiny module that renders a compile error in place of the page. */
function errorModule(message: string): string {
  const escaped = JSON.stringify(message);
  return `
const {jsx: _jsx} = arguments[0];
export const frontmatter = {};
function MDXContent() {
  return _jsx("pre", {className: "pp-compile-error", children: ${escaped}});
}
export default MDXContent;
`;
}
