# plan-presenter — living plan

## Goal

A small app that lets an AI agent present rich content (plans, data, charts,
diagrams, media) to a human and collect **inline, click-anywhere feedback** that
flows back to the agent. Ships as:

1. a **host** (Bun server) that serves the UI, watches the content directory,
   compiles MDX, and stores feedback;
2. a **web UI** (React) reachable from the local machine or over LAN;
3. an optional **desktop shell** wrapping the same UI;
4. an installable **skill** (`SKILL.md` + `pp` CLI) that tells agents how to
   author content and read feedback.

Designed so the UI + host packages can later be embedded natively in t3code.

## Environment / context

- Repo: `C:\Users\camer\git\Personal Projects\plan-presenter` (git, branch `master`)
- Toolchain: Bun 1.3.0, Node 24, Rust 1.97 + `cargo-tauri` 2.10 (unused), pnpm 11
- Default host port 27411; Vite dev 27412. Sessions default to `~/.plan-presenter/sessions`;
  `~/.plan-presenter/config.json` records `repoDir` for `pp serve`.
- Related prior art on this machine:
  - `Personal Projects/agent-bulletin-board` — Bun+Hono server, `skill-bundle/`
    pattern (SKILL.md + scripts/*.ts). The skill here mirrors that shape.
  - `vibed-out/skills-editor` — Tauri v2 + React desktop app (ports 27391/27392).
  - `Personal Projects/electrobun` — user's fork of Electrobun (1.17.x line).
  - `C:\Users\camer\git\t3code` — t3code source (see Findings).
- No prior plan-presenter implementation existed anywhere on this machine
  (searched Personal Projects, playgrounds, vibed-out, WIP tracker, global skills).

## Decisions already made (don't re-ask)

- **Content format: MDX** (`.mdx`, Markdown + JSX) with a provided component set;
  multi-page via one file per page in a session directory.
- **Charts: uPlot. Diagrams: Mermaid.** (user suggested both)
- **Folder links open locally but must not enable RCE.** Only open-dir /
  reveal-file on absolute paths inside the session's `allowedRoots`, resolved
  through symlinks, argv spawn (no shell). Nothing else executes.
- **No auth for now.** `--lan` binds 0.0.0.0; tokens later behind HTTPS.
- **Bun + `bun.lock`** (global rule). Primary branch `master`.
- **Web-first architecture:** host + web UI are the product; desktop shell is
  a thin wrapper. Makes LAN use and t3code embedding trivial.
- **Desktop shell: Electrobun 1.18.1** (pinned). Electrobun 2.0 replaced the
  npm package with a "Hutch" toolchain bootstrap (downloads launcher + engine
  on first use, new `hutch.config.ts`); unknown on this machine, and the user's
  fork tracks the 1.x line. Migrating to 2.0/Hutch is a follow-up, not blocking.
- **Host compiles MDX** (not the browser): errors surface server-side, the UI
  bundle stays small, and it's the natural split for a t3code service.
- **Feedback-to-agent text** is produced by `formatFeedbackMarkdown` in the
  protocol package and served by the host (`?format=md`), so the CLI is a thin,
  dependency-free client and a native integration reuses the same text.
- **Block ids** = hash(type + normalised excerpt) + occurrence counter: stable
  across edits elsewhere, changes when the block is rewritten (UI shows
  "block changed").
- **GitHub: `TomSawyerLabs/plan-presenter`, public** (matches the other TSL repos), default `master`.
- **Tooling: oxfmt (printWidth 100) + oxlint + lefthook**, like the newer TSL repos and t3code.
  Noisy stylistic unicorn rules are off in `.oxlintrc.json`; the React compiler rules stay on.
- **CI on GitHub Actions first**, Blacksmith later once the workflow is stable (user's call).
  Desktop builds use `electrobun build --env=canary` and upload `apps/desktop/artifacts` per platform.
- **Auto-update design (2026-09-11, user asked "add auto update").**
  - Each release publishes `manifest.json` (version, tag, sha256 + size per asset). Clients read
    `releases/latest/download/manifest.json` (GitHub redirect; no API, no rate limit), then
    download assets from the pinned tag and verify sha256 before installing anything.
  - Only _release_ installs self-update: the skill tarball carries `version.json` with
    `channel: "release"`. Dev installs (`install.ts` from a checkout, or running
    `skill/scripts/pp.ts` in the repo) are `channel: "dev"` / no version.json and never update.
  - Checks happen at most every 6 h (1 h after a failure) from a detached
    `pp __auto-update` process, so no agent command ever waits on the network.
  - Host binaries are versioned under `~/.plan-presenter/bin/<version>/` with `current.json`,
    so a running exe (locked on Windows) is never overwritten; old versions are pruned.
  - A running host is restarted into the new binary **only when idle** (no UI WebSocket
    clients, no `pp wait` long-polls), detected via `/api/health` `activity`. Hosts that can't
    report activity (0.1.0) are left running and the agent is told how to restart.
  - Desktop: Electrobun Updater against the same `latest/download` base, with a
    version guard (its updater compares hashes only, so it would offer downgrades), and a
    "Restart now / Later" prompt. Never restarts the app on its own.
  - Opt-out: `PP_NO_AUTO_UPDATE=1` or `pp auto-update off`.
  - 0.1.0 release installs have no updater code; they need one manual reinstall.

## Plan / steps

1. [x] Research prior art + toolchain.
2. [x] Decide desktop shell (Electrobun 1.18.1; see Decisions).
3. [x] Scaffold Bun workspace: `packages/protocol`, `packages/host`, `packages/ui`, `apps/desktop`, `skill/`.
4. [x] Protocol: zod schemas (session, page, block, feedback, events) + block-id allocator + formatter.
5. [x] Host: Hono REST/WS, chokidar watcher, MDX compile with block anchors, feedback store, long-poll `/wait`, safe `/api/open`, static UI.
6. [x] UI: host-compiled MDX run in browser, component set (Chart, Mermaid, Folder, Question, Callout, Section, Columns, Figure, Stat, media), click/selection -> composer, gutter markers, sidebar with reply/resolve/send, live reload, hash routing, embeddable `<PlanPresenter>` + `Transport` interface.
7. [x] Skill: SKILL.md, `pp` CLI (serve/new/page/open/review/wait/feedback/reply/resolve/ack/close/rm), installer, authoring reference.
8. [x] Desktop shell (Electrobun config + Bun main; typechecks; `electrobun build` produced `build/dev-win-x64`).
9. [x] README, example session, unit tests (17), end-to-end CLI exercise, browser check via t3code preview.
10. [x] Launch check of the built desktop app (in-process host answered on 27411, UI bundled), demo session cleaned, committed in 5 commits, skill installed to `~/.claude/skills/plan-presenter`.
11. [x] Publish to GitHub (TomSawyerLabs/plan-presenter) with CI building on all platforms.
12. [x] Release path: cross-compiled host binaries with embedded UI, `pp serve` download fallback, tag-driven release workflow (verified locally; CI run for the binaries job in progress).
13. [x] v0.1.0 released (tag pushed 2026-09-10 on user request): host binaries for five targets, stable desktop installers, skill tarball. Fresh-machine install verified from the release on Windows.
14. [x] Auto-update (design under Decisions): release manifest + sha256-verified downloads,
        skill self-update (release channel only), versioned host binaries with idle restart +
        rollback, serve lock, host `/api/health` activity, desktop updater with downgrade guard +
        prompt, release and CI wiring (E2E runs in CI), version 0.2.0. Verified: 78 tests, E2E on
        Windows, desktop updater against the real v0.1.0 release. Reaches users with the v0.2.0 tag,
        which the user pushes.
15. [ ] Next: Blacksmith runners; then public URL + token for HTTPS-fronted hosts.

## Findings / gotchas

- **t3code** (`C:\Users\camer\git\t3code`) is Electron 43 + React 19.2 + TanStack
  Router + Effect 4 RPC over WebSocket (`packages/contracts/src/rpc.ts`), Tailwind v4,
  `react-markdown` (no MDX/mermaid/charts). Relevant prior art: assistant citations
  (select text -> comment -> composer; `docs/internals/assistant-citations.md`),
  review comments (`apps/web/src/reviewCommentContext.ts`), preview annotations,
  proposed plans (`ProposedPlanCard.tsx`). MCP toolkits live in
  `apps/server/src/mcp/toolkits/<name>/{tools,handlers}.ts` (preview is the model).
  Right panel kinds: `apps/web/src/rightPanelStore.ts`. Inject text into a thread:
  `thread.turn.start` orchestration command. Tooling: pnpm + vite-plus, oxlint/oxfmt,
  tsgo, `allowImportingTsExtensions` with `./x.ts` imports (we match that style).
- **Electrobun 2.0.1 npm package is a Hutch bootstrap** (`bin/electrobun.cjs`,
  `resolve-hutch.cjs`); no runtime inside, downloads on first use. 1.18.1 ships the
  Bun API as raw `.ts` under `dist/api/bun` and downloads
  `electrobun-core-<os>-<arch>.tar.gz` (~50 MB) from GitHub releases on first CLI
  run into `node_modules/electrobun/dist-win-x64`. Its shipped `.ts` has type errors
  under our strict tsconfig, so `apps/desktop/types/electrobun.d.ts` + `paths`
  shadow the module for `tsc` only.
- **remark `hProperties`** carry `data-pp-*` onto HTML output; for
  `mdxJsxFlowElement` we push `mdxJsxAttribute`s instead, so components receive
  them as props and must spread `data-*` onto their root (all bundled components do).
- **MDX `run()`** needs `useMDXComponents` passed because the host compiles with
  `providerImportSource: "#"`.
- **Bash heredocs with certain characters** get rejected by the tool ("control
  characters"); the Write tool is the fallback. A `python3 - <<'PY' || bun -e`
  fallback chain also mis-parsed; don't chain heredocs with `||`.
- **t3code preview `snapshot` and `type` fail** on this machine but
  `preview_evaluate`/`click`/`navigate` work; DOM state was verified via evaluate.
  React state updates aren't visible in the same evaluate tick as the dispatched
  click; await ~100 ms first.
- **Test fixture gotcha:** rewriting a page without frontmatter drops its `order`,
  which changes sort position (that was a test bug, not a store bug).
- **Registering the demo session mutates `examples/demo`** (host writes
  `feedback.json` and bumps `session.json`). `examples/**/feedback.json` is
  gitignored; restore `session.json` before committing.
- **Bun `--compile` embeds files** imported `with { type: "file" }`; the import value is a
  `B:/~BUN/root/<name>` path usable with `Bun.file`, and `.type` still comes from the
  extension. Cross-compiling (`--target=bun-<os>-<arch>`) works from one machine; each
  binary is ~100-125 MB (Bun runtime + mermaid). `embedded-ui.ts` is generated before the
  build and the committed stub restored after, so the tree stays clean.
- **Bundler warning** "Unsupported JSX runtime" during `bun build --compile` comes from a
  doc comment in estree-util-build-jsx; harmless.
- **GNU sed treats an escaped pipe as alternation.** A "fix the escaped pipe" sed rewrote
  every double space in README.md (commit 5093e86; fixed in 3aa766e). Use perl or the Edit
  tool for anything containing a pipe.
- **A host started before an upgrade keeps running old code.** `pp version` shows the
  running host's version; `pp stop` + `pp serve` picks up the new one.
- **Concurrent writers race on feedback.json.** Viewer error reports, compile-time reports
  from `summary()`, and human feedback all do read-modify-write; on Windows the losing
  rename fails with EPERM. Fixed with a per-session promise chain (`SessionStore.locked`)
  plus a short EPERM/EBUSY retry in `writeJsonAtomic`. Locked methods are not re-entrant:
  internal callers use the `*Unlocked` variants.
- **remark puts `hProperties` of a `code` node on the inner `<code>`**, not the `<pre>`; the
  `Pre` override merges data attrs from the child. `RenderProblem` also resolves its block
  from the DOM (`closest("[data-pp-block]")`) so placeholders are always located.
- **MDX throws on unknown components before rendering anything** (`_missingMdxReference`),
  so an error boundary alone would blank the page. The host detects unknown capitalised
  JSX names at compile time (`KNOWN_COMPONENTS` in protocol) and the UI substitutes
  placeholder components for them.
- **Do not depend on the file watcher for correctness.** A write that lands before chokidar
  is ready (right after host start) is missed. Render errors are therefore cleared on every
  recompile with a new hash (any `getPage`), and `pp errors`/`pp review`/`pp wait` fetch the
  session summary first, which compiles every page.
- **Hono's Bun WebSocket adapter hands every event a fresh `WSContext` wrapper.** The host
  tagged the wrapper in `onOpen` and looked for the tag in `onClose`, so closed viewers were
  never removed: `clients` only grew, and the host could never look idle. Found by the
  auto-update E2E; fixed by keying clients on `ws.raw` (the underlying Bun socket), with a
  regression test (`packages/host/test/ws-activity.test.ts`).
- **Bun 1.3.0 has no `Bun.Archive`**, and the installed skill has no node_modules, so the skill
  carries its own tar reader/writer (`skill/scripts/_tar.ts`). Old GNU tar headers
  (`ustar  `) put atime/ctime where POSIX ustar has the name prefix; only use the prefix when
  byte 262 is NUL.
- **Electrobun's updater compares build hashes, not versions**, and would happily "update" a
  newer build to an older release. The desktop shell checks `isNewer()` before downloading.
- **With `release.baseUrl` set, `electrobun build --env=stable` diffs against the latest
  release at build time.** Verified locally against v0.1.0: fetched
  `stable-win-x64-update.json` through the `latest/download` redirect and produced a 47 KB
  `stable-win-x64-<prevHash>.patch` (vs a 35 MB full tarball). Canary builds find no canary
  files there and skip patching.
- **GitHub `releases/latest/download/<asset>` works for update discovery** without the API
  (no rate limit): one redirect to the newest non-prerelease release's asset.
- **`bun-types` has no `windowsHide` for `Bun.spawn`**; detached spawns are what we have.
- **Root `scripts/` was not covered by any typecheck.** Added `../scripts` to the skill's
  tsconfig include (they are skill release tooling).

## Progress log

- 2026-09-09: researched; no prior implementation found; git init.
- 2026-09-09: protocol, host, UI, skill, example, README, tests written.
  `bun run typecheck` clean across 5 workspaces; `bun test` 17/17.
  E2E on a scratch port: `pp serve/new/page/review/wait/reply/resolve/feedback`
  verified; traversal blocked; malformed JSON -> 400.
  Browser (t3code preview): demo renders 27 blocks, Mermaid SVG + uPlot present,
  block click opens composer, submit creates marker + sidebar item, "Send to agent"
  batches.
- 2026-09-09: desktop shell on Electrobun 1.18.1; `electrobun build` OK on Windows.
- 2026-09-09: built app launched and served the UI from its in-process host; installer run for real; all five workspaces typecheck; committed.
- 2026-09-09: pushed to github.com/TomSawyerLabs/plan-presenter (public). Added oxfmt/oxlint/lefthook, formatted, fixed lint. Added CI (check + 5-platform desktop matrix). First run green on all five: linux x64/arm64 (`*-Setup.tar.gz` + `.tar.zst`), windows x64 (`*-Setup-canary.zip`), macOS arm64/x64 (`.dmg` + `.app.tar.zst`), each with `*-update.json`. Artifacts ~40-70 MB per platform, ~5 min wall clock.
- 2026-09-10: version 0.1.0. Host binaries (Bun compile, UI embedded), `pp serve` binary
  fallback, `pp stop/update/version`, release.yml (tag must match package.json; builds via
  ci.yml with stable desktop env; GitHub Release with binaries + installers + skill tarball).
  Local binary smoke test OK. CI green with the new host-binaries job (all five targets,
  linux-x64 smoke-tested on the runner). Release workflow dispatched manually as a dry run: all build jobs green, release step skipped (no tag) as designed.
- 2026-09-10: render errors -> agent (system feedback kind `error`; compile, component,
  mermaid, chart, asset, runtime sources; auto-resolve on page change; `pp wait` wakes on
  them; `pp review` refuses with open errors; `pp errors`). Human sees placeholders only.
  Dead-host detection (4 s heartbeat), "lost connection" + "NOT saved" banners, text kept
  on failure. Per-session write lock after an EPERM race surfaced in testing. Verified in
  the browser end to end (placeholders, reports with line ranges, disconnect/reconnect,
  retry saved).
- 2026-09-10: v0.1.0 tagged and released via release.yml (all jobs green, GitHub Release with
  21 assets). Verified from a scratch PP_HOME with no checkout: skill tarball from the release,
  `pp serve` downloaded `pp-host-windows-x64.exe` (87 MB), host 0.1.0 up, session + UI OK.
- 2026-09-11: auto-update implemented (see Decisions). `bun run check` green, 78 tests.
  `scripts/e2e-autoupdate.ts` (real compiled host + real packaged skill vs a fake release
  server) passes on Windows: download + start, update with restart deferred while a viewer
  is connected, background idle restart into the new binary, one-time agent notice, tampered
  release refused with nothing changed, stop. Its first run caught the WebSocket client leak.
  Local stable desktop build generated a 47 KB delta patch against v0.1.0.
- 2026-09-11: desktop updater verified against the real GitHub v0.1.0 release from an
  unpacked stable build (temp copy, scratch port): claiming 0.3.0 it saw 0.1.0 and ignored it
  (downgrade guard); claiming 0.0.1 it downloaded the 35 MB bundle via latest/download in ~2 s,
  decompressed it and reached "download-complete" (the Restart/Later prompt point). Test copy,
  stable app-data and desktop-update.log removed afterwards.

## Open questions for the user

1. Electrobun 2.0 / Hutch: migrate now or later? Recommendation: later; the shell
   is ~60 lines and 1.18.1 builds.
2. Should sessions default to living inside the project
   (`<project>/.plan-presenter/<id>`) instead of `~/.plan-presenter/sessions`?
   Recommendation: keep the home default (no repo pollution); `pp new --dir` when wanted.
3. Code highlighting (Shiki, as t3code uses) in pages: not included yet to keep the
   bundle small. Add?

## Follow-ups (not started)

- Electrobun 2.0/Hutch migration; app icon; tray/menu; "open in app" from `pp review`.
- Auth token + HTTPS mode for LAN/remote use.
- Shiki code highlighting; image lightbox; keyboard navigation between blocks.
- t3code native integration: MCP toolkit `plan/` (tools: plan_open, plan_wait,
  plan_reply), contract module, `RightPanelKind` "plan", `Transport` over Effect
  RPC, feedback -> `thread.turn.start`.
  Parallel wiring a new toolkit needs (from the survey): tool descriptions for the
  agent prompt in `apps/server/src/provider/CodexDeveloperInstructions.ts`; per-toolkit
  enable toggle in `packages/contracts/src/settings.ts` +
  `apps/web/src/components/settings/IntegrationsSettings.tsx`; a request/response
  contract like `packages/contracts/src/previewAutomation.ts` carried by a broker
  (`PreviewAutomationBroker.ts` is the model); timeline labels in
  `packages/client-runtime/src/work-log/presentation.ts`. The preview feature is
  split across four dirs (`apps/desktop/src/preview`, `apps/server/src/mcp/toolkits/preview`,
  `apps/server/src/preview`, `apps/web/src/components/preview`); mirror that split.
- Compile errors that are reported at write time never reach a viewer, so their agent
  message is the only signal; consider also surfacing the count in `pp status`.
- Agent-side hook: auto `pp wait` via a Stop hook (like bulletin-board's async
  rewake) so the agent resumes when feedback arrives without a blocking bash call.
- Release workflow: tag -> build all platforms -> GitHub Release with installers; then let `pp serve` fetch a release instead of needing a checkout.
- Move CI runners to Blacksmith once the workflow is stable.

## Things not to do

- Do not rename `master` to `main`.
- Do not expose any endpoint that runs a shell command or opens arbitrary URIs.
- Do not let the UI compile MDX in the browser (keep the host as the compiler).
- Do not commit `examples/demo/feedback.json` or a mutated `examples/demo/session.json`.
