# plan-presenter

[![CI](https://github.com/TomSawyerLabs/plan-presenter/actions/workflows/ci.yml/badge.svg)](https://github.com/TomSawyerLabs/plan-presenter/actions/workflows/ci.yml)

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

## Install (any machine with Bun)

Grab the skill bundle from the [latest release](https://github.com/TomSawyerLabs/plan-presenter/releases/latest)
and unpack it into your skills directory:

```sh
mkdir -p ~/.claude/skills/plan-presenter
curl -L https://github.com/TomSawyerLabs/plan-presenter/releases/latest/download/plan-presenter-skill.tar.gz \
  | tar -xz -C ~/.claude/skills/plan-presenter
```

The first `pp serve` downloads a self-contained host binary for your platform
(`pp-host-<os>-<arch>`: Bun runtime + host + UI, ~100 MB) into
`~/.plan-presenter/bin`. `pp update` refreshes it. Desktop installers for
Windows, macOS, and Linux are on the same release page.

## Development install (from a checkout)

```sh
git clone git@github.com:TomSawyerLabs/plan-presenter.git
cd plan-presenter
bun install
bun run build                       # builds the UI into packages/ui/dist
bun run skill/scripts/install.ts    # installs the skill to ~/.claude/skills/plan-presenter
                                    #   (--project for ./.claude/skills)
```

The installer records the checkout in `~/.plan-presenter/config.json`, so
`pp serve` runs the host from source (serving `packages/ui/dist`) instead of
the prebuilt binary.

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
bun run check      # format:check + lint + typecheck + test (what CI runs)
```

Formatting is oxfmt, linting is oxlint; lefthook runs both on staged files at
commit (installed by `bun install` via `prepare`).

Desktop shell (Electrobun 1.18; downloads platform binaries on first run):

```sh
bun run build
cd apps/desktop && bun run dev
```

Self-contained host binaries (what `pp serve` uses when there is no checkout):

```sh
bun run build
bun run packages/host/scripts/build-binaries.ts --current   # omit --current for all five targets
packages/host/bin/pp-host-<os>-<arch> --version
```

## Releasing

Bump `version` in every `package.json` and in `apps/desktop/electrobun.config.ts`,
commit, then push a matching tag:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/release.yml` checks the tag against `package.json`, runs the
full CI with stable desktop builds, and creates a GitHub Release carrying the
host binaries, the desktop installers, and the skill bundle. Nothing is
published from a workstation.

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

## Render errors go to the agent, not the human

Anything that fails to render is reported to the agent automatically as a
system feedback item of kind `error`: MDX compile errors (the host compiles a
page the moment it is written), unknown component names (flagged at compile
time with their line; the viewer renders a placeholder so the rest of the page
still shows), Mermaid syntax errors, chart data problems, missing images or
media, and runtime errors in the viewer. `pp wait` returns them immediately,
`pp review` refuses while any are open, `pp errors` lists them, and they
resolve themselves when the page compiles and renders cleanly again. The human
only sees "Couldn't render this diagram. The agent has been notified."

## Nothing is silently lost

Every feedback item is saved to the host the moment it is submitted; "Send to
agent" only groups what is already saved into a batch. The UI polls the host
every few seconds, so a crashed or hung host shows a full-width "lost the
connection" banner within seconds, and any write that fails shows a "NOT
saved" notice while keeping the text in place to retry. Server-side, writes to
a session are serialised so concurrent reports and feedback cannot clobber
each other.

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

Core loop works end to end (host, UI, CLI, skill). CI builds the desktop app on
five platforms and cross-compiles host binaries; releases are tag-driven. The
desktop shell is on Electrobun 1.18 (2.0 moved to the "Hutch" toolchain;
migrating is a follow-up). No auth yet.
