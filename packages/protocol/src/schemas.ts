import { z } from "zod";

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** Session ids are filesystem-safe slugs: lowercase letters, digits, `-`, `_`. */
export const SessionId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export type SessionId = z.infer<typeof SessionId>;

/** Page ids are the mdx filename without extension (e.g. `01-overview`). */
export const PageId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export type PageId = z.infer<typeof PageId>;

// ---------------------------------------------------------------------------
// Session manifest - `session.json` in the session directory (agent-authored)
// ---------------------------------------------------------------------------

export const SessionStatus = z.enum([
  /** Agent is still writing/editing; human may already be looking. */
  "drafting",
  /** Agent asked the human to review. */
  "awaiting-review",
  /** Human pressed "Send to agent" - a feedback batch is ready. */
  "reviewed",
  /** Agent (or human) closed the session. */
  "closed",
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const SessionManifest = z.object({
  id: SessionId,
  title: z.string().min(1),
  status: SessionStatus.default("drafting"),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /**
   * Absolute directories the UI may ask the host to open in the OS file
   * manager. Anything outside these roots is refused. Usually the project
   * root the agent is working in.
   */
  allowedRoots: z.array(z.string()).default([]),
  /** Explicit page order. Pages not listed are appended alphabetically. */
  pages: z.array(PageId).default([]),
  /** Free-form metadata the agent may attach (thread id, project name, ...). */
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type SessionManifest = z.infer<typeof SessionManifest>;

// ---------------------------------------------------------------------------
// Pages & blocks
// ---------------------------------------------------------------------------

/**
 * A block is any element in the rendered page that can be commented on.
 * Ids are assigned at compile time and are stable across edits elsewhere in
 * the document (see `BlockIdAllocator` in ./blocks.ts).
 */
export const BlockInfo = z.object({
  id: z.string(),
  /** mdast node type: paragraph, heading, listItem, code, table, mdxJsxFlowElement, ... */
  type: z.string(),
  /** 1-based source line range in the .mdx file. */
  line: z.object({ start: z.number().int(), end: z.number().int() }),
  /** First ~120 chars of the block's text, for humans and agents to locate it. */
  excerpt: z.string(),
});
export type BlockInfo = z.infer<typeof BlockInfo>;

export const PageFrontmatter = z.looseObject({
  title: z.string().optional(),
  /** Lower sorts first when the manifest doesn't pin an order. */
  order: z.number().optional(),
});
export type PageFrontmatter = z.infer<typeof PageFrontmatter>;

export const CompiledPage = z.object({
  sessionId: SessionId,
  id: PageId,
  frontmatter: PageFrontmatter,
  /** Compiled MDX as a function-body module (run in the UI with `@mdx-js/mdx` `run()`). */
  code: z.string(),
  blocks: z.array(BlockInfo),
  /** Hash of the source; the UI uses it to skip redundant re-renders. */
  hash: z.string(),
  /** Compile error, if any. `code` is then a fallback that renders the error. */
  error: z.string().nullable(),
  /**
   * Capitalised JSX names used in the page that are not provided components.
   * The viewer renders placeholders for them; the host reports each as a
   * render error so the page still displays instead of throwing.
   */
  unknownComponents: z.array(z.string()).default([]),
});
export type CompiledPage = z.infer<typeof CompiledPage>;

export const PageSummary = z.object({
  id: PageId,
  title: z.string(),
  openFeedback: z.number().int(),
});
export type PageSummary = z.infer<typeof PageSummary>;

export const SessionSummary = SessionManifest.extend({
  dir: z.string(),
  pageSummaries: z.array(PageSummary),
  openFeedback: z.number().int(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

// ---------------------------------------------------------------------------
// Feedback - `feedback.json` in the session directory (host-owned)
// ---------------------------------------------------------------------------

export const FeedbackKind = z.enum([
  /** General remark. */
  "comment",
  /** Human wants something changed. */
  "change",
  /** Human asks the agent for clarification / more detail. */
  "question",
  /** Human asks the agent to do a follow-up task. */
  "request",
  /** Human explicitly signs off on this block. */
  "approve",
  /** Human rejects this block/idea. */
  "reject",
  /** Answer to an inline <Question> the agent posed in the page. */
  "answer",
  /** Rendering problem reported by the host or the viewer (author "system"); goes to the agent. */
  "error",
]);
export type FeedbackKind = z.infer<typeof FeedbackKind>;

export const FeedbackStatus = z.enum(["open", "acknowledged", "resolved"]);
export type FeedbackStatus = z.infer<typeof FeedbackStatus>;

export const Author = z.enum(["human", "agent", "system"]);
export type Author = z.infer<typeof Author>;

/** Where on the page a feedback item is attached. `null` block = whole page. */
export const Anchor = z.object({
  pageId: PageId,
  blockId: z.string().nullable(),
  /** Snapshot of the block at comment time, so the agent can find it in source. */
  block: BlockInfo.nullable(),
  /** Text the human highlighted inside the block, if any. */
  selection: z.string().nullable().default(null),
  /**
   * For `answer` feedback: the <Question id> it answers. For component
   * feedback (charts etc.) the component's `id` prop.
   */
  targetId: z.string().nullable().default(null),
});
export type Anchor = z.infer<typeof Anchor>;

export const Reply = z.object({
  id: z.string(),
  author: Author,
  body: z.string(),
  createdAt: z.iso.datetime(),
});
export type Reply = z.infer<typeof Reply>;

export const Feedback = z.object({
  id: z.string(),
  sessionId: SessionId,
  kind: FeedbackKind,
  status: FeedbackStatus.default("open"),
  author: Author.default("human"),
  anchor: Anchor,
  body: z.string(),
  /** Structured payload for `answer` kind (selected option(s), form values). */
  data: z.unknown().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  replies: z.array(Reply).default([]),
  /**
   * Set when the human presses "Send to agent"; groups feedback into batches
   * so `pp wait` can return exactly the new items.
   */
  batch: z.number().int().nullable().default(null),
});
export type Feedback = z.infer<typeof Feedback>;

export const FeedbackFile = z.object({
  version: z.literal(1),
  /** Monotonic; incremented each time the human sends a batch. */
  lastBatch: z.number().int().default(0),
  items: z.array(Feedback).default([]),
});
export type FeedbackFile = z.infer<typeof FeedbackFile>;

// ---------------------------------------------------------------------------
// API request bodies
// ---------------------------------------------------------------------------

export const CreateFeedback = z.object({
  kind: FeedbackKind,
  anchor: Anchor,
  body: z.string().default(""),
  data: z.unknown().optional(),
  author: Author.default("human"),
});
export type CreateFeedback = z.infer<typeof CreateFeedback>;

export const UpdateFeedback = z.object({
  body: z.string().optional(),
  kind: FeedbackKind.optional(),
  status: FeedbackStatus.optional(),
});
export type UpdateFeedback = z.infer<typeof UpdateFeedback>;

export const CreateReply = z.object({
  author: z.enum(["human", "agent"]),
  body: z.string().min(1),
});
export type CreateReply = z.infer<typeof CreateReply>;

export const CreateSession = z.object({
  id: SessionId.optional(),
  title: z.string().min(1),
  allowedRoots: z.array(z.string()).default([]),
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type CreateSession = z.infer<typeof CreateSession>;

export const UpdateSession = z.object({
  title: z.string().min(1).optional(),
  status: SessionStatus.optional(),
  allowedRoots: z.array(z.string()).optional(),
  pages: z.array(PageId).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateSession = z.infer<typeof UpdateSession>;

export const OpenPathRequest = z.object({
  sessionId: SessionId,
  path: z.string().min(1),
});
export type OpenPathRequest = z.infer<typeof OpenPathRequest>;

// ---------------------------------------------------------------------------
// Live events (WebSocket, host -> UI and host -> agent CLI)
// ---------------------------------------------------------------------------

export const LiveEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), hostVersion: z.string() }),
  z.object({ type: z.literal("session.changed"), sessionId: SessionId }),
  z.object({ type: z.literal("session.removed"), sessionId: SessionId }),
  z.object({ type: z.literal("page.changed"), sessionId: SessionId, pageId: PageId }),
  z.object({ type: z.literal("page.removed"), sessionId: SessionId, pageId: PageId }),
  z.object({ type: z.literal("asset.changed"), sessionId: SessionId, path: z.string() }),
  z.object({ type: z.literal("feedback.changed"), sessionId: SessionId, feedbackId: z.string() }),
  z.object({ type: z.literal("feedback.batch"), sessionId: SessionId, batch: z.number().int() }),
  z.object({
    type: z.literal("render.error"),
    sessionId: SessionId,
    pageId: PageId,
    feedbackId: z.string(),
  }),
]);
export type LiveEvent = z.infer<typeof LiveEvent>;

// ---------------------------------------------------------------------------
// Render errors (host compile errors and viewer-side failures). Stored as
// feedback items with author "system" and kind "error"; the agent sees them
// in `pp wait` immediately, the human sees only a short placeholder.
// ---------------------------------------------------------------------------

export const RenderErrorSource = z.enum([
  /** MDX failed to compile on the host. */
  "compile",
  /** The compiled module threw while evaluating in the viewer. */
  "runtime",
  /** A component threw while rendering (e.g. unknown component name). */
  "component",
  "mermaid",
  "chart",
  /** Image/video/audio/data file failed to load. */
  "asset",
]);
export type RenderErrorSource = z.infer<typeof RenderErrorSource>;

export const ReportRenderError = z.object({
  pageId: PageId,
  blockId: z.string().nullable().default(null),
  block: BlockInfo.nullable().default(null),
  targetId: z.string().nullable().default(null),
  source: RenderErrorSource,
  /** One line, what went wrong. */
  message: z.string().min(1),
  /** Longer context (stack, offending source), for the agent only. */
  detail: z.string().nullable().default(null),
});
export type ReportRenderError = z.infer<typeof ReportRenderError>;

/** Shape of `Feedback.data` for kind "error". */
export interface RenderErrorData {
  source: RenderErrorSource;
  detail: string | null;
  /** How many times the same error was reported. */
  count: number;
}
