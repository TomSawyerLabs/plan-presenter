# plan-presenter

An AI agent writes a plan, analysis, or design as MDX pages (Markdown plus a
small set of React components: charts, Mermaid diagrams, media, folder links,
inline questions). A human opens it in a browser or the desktop app, clicks on
**any** paragraph, list item, chart, or diagram to leave feedback, and presses
**Send to agent**. The agent's `pp wait` call returns, with the feedback as
Markdown pointing at exact source lines. The agent edits the pages in place,
the UI live-reloads, the agent replies and resolves, and the loop repeats.

```
agent ──writes .mdx──▶ session dir ◀──watches── host (Bun) ◀──HTTP/WS──▶ browser / desktop app
agent ◀── pp wait ─────────────────────────────── host ◀── "Send to agent" ── human
```

## Layout

| Path                | What                                                                                                                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol` | Zod schemas and types shared by everything: session manifest, compiled pages, block anchors, feedback, live events; the agent-facing Markdown formatter.                                                                                       |
| `packages/host`     | Bun host: compiles MDX with per-block anchors (stable ids + source lines), watches session dirs, stores feedback as JSON in the session dir, serves the UI, REST + WebSocket, safe "open folder". Framework-agnostic core plus a Hono adapter. |
| `packages/ui`       | React UI (Vite). Click-anywhere feedback, selection quoting, gutter markers, feedback sidebar, live reload. Exported as an embeddable `<PlanPresenter>` with a pluggable `Transport`.                                                          |
| `apps/desktop`      | Thin Electrobun shell: runs the host in-process and opens a native window.                                                                                                                                                                     |
| `skill/`            | Installable agent skill: `SKILL.md`, the dependency-free `pp` CLI, an authoring reference.                                                                                                                                                     |
| `examples/demo`     | A sample session (register it to try the UI).                                                                                                                                                                                                  |
| `plans/`            | Living design/progress doc.                                                                                                                                                                                                                    |

## Quick start

```sh
bun install
bun run build                       # builds the UI into packages/ui/dist
bun run skill/scripts/install.ts    # installs the skill to ~/.claude/skills/plan-presenter
                                    #   (--project for ./.claude/skills)
```

Then, as an agent (or by hand):

```sh
PP="bun run ~/.claude/skills/plan-presenter/scripts/pp.ts"
$PP serve                           # starts the host at http://127.0.0.1:27411 (add --lan for 0.0.0.0)
$PP new "My plan" --root "$PWD"     # prints the session dir + URL
# write <session dir>/pages/01-overview.mdx ...
$PP review <id> --open              # marks awaiting-review, opens the browser
$PP wait <id>                       # blocks until the human presses "Send to agent"
$PP reply <id> <feedbackId> "done"; $PP resolve <id> <feedbackId>
```

To look at the bundled example: `$PP serve`, then register it:

```sh
curl -X POST -H 'content-type: application/json' http://127.0.0.1:27411/api/sessions/register \
  -d '{"dir":"<abs path to>/examples/demo"}'
```

and open `http://127.0.0.1:27411/#/s/demo`.

## Development

```sh
bun run dev        # host with hot reload on :27411 (serves packages/ui/dist if built)
bun run dev:ui     # Vite dev server on :27412, proxies /api and /ws to the host
bun run typecheck  # every workspace
bun test           # host + protocol unit tests
```

Desktop shell (Electrobun 1.18; downloads platform binaries on first run):

```sh
bun run build
cd apps/desktop && bun run dev
```

## Session layout (what the agent writes)

```
<session dir>/
  session.json       id, title, status, allowedRoots, page order, meta
  pages/*.mdx        one page per file; frontmatter title/order
  assets/**          images, video, audio (served read-only)
  data/*.json        chart data
  feedback.json      host-owned; agents may read it directly
```

Sessions live under `~/.plan-presenter/sessions/<id>` by default, or anywhere
(`pp new --dir`), which registers the directory with the host.

## Components available in pages

`<Chart>` (uPlot; line/bars/points; inline or JSON-file data), Mermaid via
` ```mermaid ` fences or `<Mermaid>`, `<Question>` (single/multi choice
and free text; answers arrive as feedback), `<Folder path>` and
`[text](file:///…)` (opens the OS file manager on the host machine, only inside
the session's allowed roots; never executes anything), `<Callout>`, `<Section>`,
`<Columns>`/`<Column>`, `<Figure>`, `<Stat>`, `<Video>`, `<Audio>`, plus plain
GFM Markdown. Full reference: [`skill/reference/authoring.md`](skill/reference/authoring.md).

## Feedback model

Every block-level element gets a stable id (hash of its type + text) and a
source line range at compile time. Feedback anchors to `{page, blockId, block
snapshot, selected text, targetId}` so it stays attached while other parts of
the page change, and shows "block changed" when the anchored text was rewritten.
Kinds: comment, change, question, request (follow-up), approve, reject, answer.
"Send to agent" stamps pending items with a batch number; `pp wait` returns
exactly that batch.

## Security posture (deliberately minimal for now)

- No authentication. Bind to `127.0.0.1` by default; `--lan` binds `0.0.0.0`
  for viewing from other devices on a trusted network. Tokens can come later
  behind HTTPS.
- The only host-side side effect the UI can trigger is "open in file manager",
  restricted to absolute paths inside the session's `allowedRoots`, resolved
  through symlinks, spawned without a shell, and files are only _revealed_.
- MDX is agent-authored JavaScript that runs in the viewer's browser; treat
  sessions as trusted content from your own agent.

## Integrating into another app (e.g. t3code)

The pieces were cut so a native integration reuses them rather than the
standalone server:

- `@plan-presenter/protocol` is the contract (schemas, block ids, formatter).
- `@plan-presenter/host` exports `SessionStore`, `compilePage`,
  `SessionWatcher`, and `openInFileManager` independently of Hono; wrap them in
  your own RPC.
- `@plan-presenter/ui` exports `<PlanPresenter transport={…} sessionId={…}/>`
  and the `Transport` interface; implement it over your existing connection.
- `formatFeedbackMarkdown` produces the text to inject into the agent's thread.

See `plans/plan-presenter.md` for the t3code-specific notes.

## Status

Greenfield. Core loop works end to end (host, UI, CLI, skill). Desktop shell
is scaffolded on Electrobun 1.18 (Electrobun 2.0 moved to the "Hutch"
toolchain; migrating is a follow-up). No auth yet.
