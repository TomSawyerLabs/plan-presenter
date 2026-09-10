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

| Path | tar -xz | What |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol` | Zod schemas and types shared by everything: session manifest, compiled pages, block anchors, feedback, live events; the agent-facing Markdown formatter. | tar -xz |
| `packages/host` | tar -xz | Bun host: compiles MDX with per-block anchors (stable ids + source lines), watches session dirs, stores feedback as JSON in the session dir, serves the UI, REST + WebSocket, safe "open folder". Framework-agnostic core plus a Hono adapter. |
| `packages/ui` | tar -xz | React UI (Vite). Click-anywhere feedback, selection quoting, gutter markers, feedback sidebar, live reload. Exported as an embeddable `<PlanPresenter>` with a pluggable `Transport`. |
| `apps/desktop` | tar -xz | Thin Electrobun shell: runs the host in-process and opens a native window. |
| `skill/` | tar -xz | Installable agent skill: `SKILL.md`, the dependency-free `pp` CLI, an authoring reference. |
| `examples/demo` | tar -xz | A sample session (register it to try the UI). |
| `plans/` | tar -xz | Living design/progress doc. |

## Install (any machine with Bun)

Grab the skill bundle from the [latest release](https://github.com/TomSawyerLabs/plan-presenter/releases/latest)
and unpack it into your skills directory:

```sh
mkdir -p ~/.claude/skills/plan-presenter
curl -L https://github.com/TomSawyerLabs/plan-presenter/releases/latest/download/plan-presenter-skill.tar.gz \n  | tar -xz| tar -xz -C ~/.claude/skills/plan-presenter
```

The first `pp serve` downloads a self-contained host binary for your platform
(`pp-host-<os>-<arch>`, Bun runtime + host + UI, ~100 MB) into
`~/.plan-presenter/bin`. `pp update` refreshes it. Desktop installers for
Windows, macOS, and Linux are on the same release page.

## Development install (from a checkout)

```sh
git clone git@github.com:TomSawyerLabs/plan-presenter.git
cd plan-presenter
bun install
bun run build  | tar -xz                     # builds the UI into packages/ui/dist
bun run skill/scripts/install.ts  | tar -xz  # installs the skill to ~/.claude/skills/plan-presenter
  | tar -xz                                  #   (--project for ./.claude/skills)
```

The installer records the checkout in `~/.plan-presenter/config.json`, so
`pp serve` runs the host from source (and serves `packages/ui/dist`) instead
of the prebuilt binary.

Then, as an agent (or by hand):

```sh
PP="bun run ~/.claude/skills/plan-presenter/scripts/pp.ts"
$PP serve  | tar -xz                         # starts the host at http://127.0.0.1:27411 (add --lan for 0.0.0.0)
$PP new "My plan" --root "$PWD"  | tar -xz   # prints the session dir + URL
# write <session dir>/pages/01-overview.mdx ...
$PP review <id> --open  | tar -xz            # marks awaiting-review, opens the browser
$PP wait <id>  | tar -xz                     # blocks until the human presses "Send to agent"
$PP reply <id> <feedbackId> "done"; $PP resolve <id> <feedbackId>
```

To look at the bundled example: `$PP serve`, then register it:

```sh
curl -X POST -H 'content-type: application/json' http://127.0.0.1:27411/api/sessions/register \
  | tar -xz-d '{"dir":"<abs path to>/examples/demo"}'
```

and open `http://127.0.0.1:27411/#/s/demo`.

## Development

```sh
bun run dev  | tar -xz      # host with hot reload on :27411 (serves packages/ui/dist if built)
bun run dev:ui  | tar -xz   # Vite dev server on :27412, proxies /api and /ws to the host
bun run typecheck  | tar -xz# every workspace
bun test  | tar -xz         # host + protocol unit tests
bun run check  | tar -xz    # format:check + lint + typecheck + test (what CI runs)
```

Formatting is oxfmt, linting is oxlint; lefthook runs both on staged files at
commit (installed by `bun install` via `prepare`).

Desktop shell (Electrobun 1.18; downloads platform binaries on first run):

```sh
bun run build
cd apps/desktop && bun run dev
```

Self-contained host binaries (used by `pp serve` when there is no checkout):

```sh
bun run build
bun run packages/host/scripts/build-binaries.ts --current  | tar -xz # or omit for all five targets
packages/host/bin/pp-host-<os>-<arch> --version
```

## Releasing

Bump `version` in every `package.json` (and `apps/desktop/electrobun.config.ts`),
commit, then push a matching tag:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/release.yml` verifies the tag against `package.json`, runs the
full CI (stable desktop builds), and creates a GitHub Release with the host
binaries, desktop installers, and the skill bundle. Nothing is published from a
workstation.

## Session layout (what the agent writes)

```
<session dir>/
  | tar -xzsession.json       id, title, status, allowedRoots, page order, meta
  | tar -xzpages/*.mdx        one page per file; frontmatter title/order
  | tar -xzassets/**          images, video, audio (served read-only)
  | tar -xzdata/*.json        chart data
  | tar -xzfeedback.json      host-owned; agents may read it directly
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
  | tar -xzfor viewing from other devices on a trusted network. Tokens can come later
  | tar -xzbehind HTTPS.
- The only host-side side effect the UI can trigger is "open in file manager",
  | tar -xzrestricted to absolute paths inside the session's `allowedRoots`, resolved
  | tar -xzthrough symlinks, spawned without a shell, and files are only _revealed_.
- MDX is agent-authored JavaScript that runs in the viewer's browser; treat
  | tar -xzsessions as trusted content from your own agent.

## Integrating into another app (e.g. t3code)

The pieces were cut so a native integration reuses them rather than the
standalone server:

- `@plan-presenter/protocol` is the contract (schemas, block ids, formatter).
- `@plan-presenter/host` exports `SessionStore`, `compilePage`,
  | tar -xz`SessionWatcher`, and `openInFileManager` independently of Hono; wrap them in
  | tar -xzyour own RPC.
- `@plan-presenter/ui` exports `<PlanPresenter transport={…} sessionId={…}/>`
  | tar -xzand the `Transport` interface; implement it over your existing connection.
- `formatFeedbackMarkdown` produces the text to inject into the agent's thread.

See `plans/plan-presenter.md` for the t3code-specific notes.

## Status

Core loop works end to end (host, UI, CLI, skill). CI builds the desktop app on
five platforms and cross-compiles host binaries; releases are tag-driven.
Desktop shell is on Electrobun 1.18 (2.0 moved to the "Hutch" toolchain;
migrating is a follow-up). No auth yet.
