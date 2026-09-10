/**
 * Stable block ids.
 *
 * A block id must survive edits elsewhere in the document (so feedback stays
 * attached while the agent fixes a different paragraph) but should change when
 * the block itself is rewritten (so stale feedback is visibly orphaned rather
 * than silently pointing at new text). We hash the node type plus a normalised
 * text excerpt, and disambiguate duplicates with an occurrence counter.
 */

export function normaliseExcerpt(text: string, max = 120): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/** FNV-1a 32-bit: tiny, dependency-free, good enough for short ids. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export class BlockIdAllocator {
  private seen = new Map<string, number>();

  /** @returns e.g. `p-3f2a9c1e`, or `p-3f2a9c1e-2` for the second identical block. */
  next(type: string, excerpt: string): string {
    const short = TYPE_PREFIX[type] ?? type.slice(0, 4).toLowerCase();
    const base = `${short}-${fnv1a(`${type} ${normaliseExcerpt(excerpt)}`)}`;
    const n = (this.seen.get(base) ?? 0) + 1;
    this.seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  }
}

const TYPE_PREFIX: Record<string, string> = {
  paragraph: "p",
  heading: "h",
  list: "ul",
  listItem: "li",
  code: "code",
  blockquote: "q",
  table: "tbl",
  image: "img",
  thematicBreak: "hr",
  html: "html",
  mdxJsxFlowElement: "jsx",
  mdxFlowExpression: "expr",
};

/** DOM attribute names used by the UI to find block anchors. */
export const BLOCK_ATTR = "data-pp-block";
export const BLOCK_TYPE_ATTR = "data-pp-type";
export const BLOCK_LINE_ATTR = "data-pp-line";

/**
 * Components the UI provides to pages. The host uses this to flag unknown
 * capitalised JSX names at compile time; the UI has a test asserting its
 * component map covers exactly this list.
 */
export const KNOWN_COMPONENTS = [
  "Chart",
  "Mermaid",
  "Folder",
  "Question",
  "Callout",
  "Section",
  "Columns",
  "Column",
  "Figure",
  "Stat",
  "Video",
  "Audio",
  "Image",
] as const;
