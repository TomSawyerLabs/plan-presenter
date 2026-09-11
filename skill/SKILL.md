---
name: plan-presenter
description: Present a plan, analysis, data, or design to the human in a rich clickable UI (Markdown + React components, charts, Mermaid diagrams, media, links that open local folders) and collect their inline feedback. Use when a plan or result is too big or too visual for chat, when you need sign-off on specific parts, or when you want to ask several structured questions at once.
---

# plan-presenter

You write `.mdx` pages into a session directory; the human reviews them in a
browser (or the desktop app) and clicks on anything to leave feedback; you read
the feedback, edit the pages in place (the UI live-reloads), reply, and repeat.

The `pp` CLI in this skill's `scripts/` is the only interface you need:

```sh
bun run ~/.claude/skills/plan-presenter/scripts/pp.ts <command>
```

Define `PP="bun run ~/.claude/skills/plan-presenter/scripts/pp.ts"` once per
shell and use `$PP …` below. (If the skill is installed per-project, the path
is `.claude/skills/plan-presenter/scripts/pp.ts`.)

## The loop

1. **Start the host** (idempotent): `$PP serve` — add `--lan` if the human
   will view from another device. Prints the URL.
2. **Create a session**: `$PP new "Title" --root <project dir>` — prints the
   session id, its directory, and the URL. `--root` whitelists directories that
   `<Folder>` links may open; it defaults to the cwd. Use `--dir <path>` to keep
   the session inside the project instead of `~/.plan-presenter/sessions`.
3. **Write pages** to `<session dir>/pages/NN-name.mdx` (write the files
   directly; or `$PP page <id> <pageId> --file x.mdx`). See
   [reference/authoring.md](reference/authoring.md) for the component set.
   Put images/data under `<session dir>/assets/` and reference them relatively.
4. **Ask for review**: `$PP review <id> --open` marks the session
   _awaiting-review_ and opens the browser on the host machine. Tell the human
   the URL as well.
5. **Wait**: `$PP wait <id>` blocks (up to 9 minutes, re-run to keep waiting)
   until the human presses **Send to agent**, then prints their feedback as
   Markdown with page paths, line ranges, block excerpts, and any selected text.
   Exit code 3 means timed out with nothing sent.
6. **Act**: edit the `.mdx` in place, fix what was asked, then for each item
   `$PP reply <id> <feedbackId> "what you did"` and `$PP resolve <id> <feedbackId>`.
   Unresolved items stay visible to the human. Then go to step 4 again.
7. **Finish**: `$PP close <id>` when the plan is accepted.

Keep turns short: present, wait, act. Do not poll `pp feedback` in a loop;
`pp wait` already long-polls.

## Feedback kinds you will receive

| kind                    | meaning                           | what to do                                              |
| ----------------------- | --------------------------------- | ------------------------------------------------------- |
| `COMMENT`               | a remark                          | acknowledge or fold into the plan                       |
| `CHANGE REQUESTED`      | edit this block                   | edit the source lines, reply with what changed, resolve |
| `QUESTION`              | explain/clarify                   | reply inline (`pp reply`) and/or expand the page        |
| `FOLLOW-UP REQUEST`     | do extra work                     | do it (possibly a new page), reply, resolve             |
| `APPROVED` / `REJECTED` | sign-off per block                | respect it; rejected blocks need a new approach         |
| `ANSWER`                | reply to a `<Question>` you posed | read `Selected:` / `Text:` and proceed                  |

Each item carries `id`, the page file path, `lines a-b`, the block type and a
text excerpt, and `Selected text` when the human highlighted a phrase. Use the
line range to find the block; the excerpt to double-check.

## Asking the human structured questions

Inside a page:

```mdx
<Question id="db" options={["Postgres", "SQLite"]}>
  Which store for v1?
</Question>
<Question id="risk" options={["Yes", "No", "Not sure"]} multiple text>
  Any risks I missed?
</Question>
```

Answers arrive as `ANSWER · target #db` items in `pp wait` output.

## Render errors come to you automatically

Anything that fails to render is reported to you without the human doing
anything: MDX compile errors (as soon as you save the file), Mermaid syntax
errors, chart data problems, missing images/media, unknown component names,
runtime errors. They arrive as `RENDER ERROR` items:

- `$PP wait <id>` returns immediately with the open render errors (no "Send to
  agent" needed), including the page path, line range, the source (`compile`,
  `mermaid`, `chart`, `asset`, `component`, `runtime`) and the failing snippet.
- `$PP review <id>` refuses (exit 4) while render errors are open, so the human
  never gets a broken page. `--force` overrides.
- `$PP page` prints a compile error and exits 4.
- `$PP errors <id>` lists them any time (`--all` includes resolved).

Fix the source and save; errors auto-resolve when the page compiles and renders
cleanly again. The human only sees a short placeholder ("couldn't render this
diagram; the agent has been notified"), never the error text, so do not wait
for them to report it.

## Rules

- One session per plan/thread; multiple pages for long material (`01-overview.mdx`,
  `02-details.mdx`, …). Page frontmatter `title:` names the tab.
- Prefer charts (`<Chart>`) for numbers over walls of text, and Mermaid for
  flows/architecture. See the authoring reference for exact props.
- Never put secrets in a session; the host has no auth and may be on the LAN.
- `<Folder path="…">` and `[text](file:///…)` links open the OS file manager
  on the host machine, only inside `allowedRoots`. Nothing else executes.
- If `pp` cannot reach the host, run `$PP serve`. It starts the host from the repo
  checkout recorded in `~/.plan-presenter/config.json` (dev installs), otherwise
  from a prebuilt binary in `~/.plan-presenter/bin` that it downloads from GitHub
  Releases on first use. `$PP stop` stops the host.
- plan-presenter keeps itself up to date in the background; you never need to
  run an update. When `pp` prints `plan-presenter updated X -> Y; re-read
SKILL.md`, re-read this file before continuing: commands or components may
  have changed.

## Command reference

```
pp serve [--lan] [--port N]              start the host if not running
pp stop                                  stop the host started by pp serve
pp status [<session>]                    host health, or session summary + URL
pp sessions                              list sessions
pp new "<title>" [--id x] [--root DIR] [--dir DIR]
pp page <session> <pageId> [--file F]    write a page (stdin if no --file)
pp open <session> [--page P]             open the UI in the host's browser
pp review <session> [--open] [--force]   status -> awaiting-review (refuses with open render errors)
pp wait <session> [--timeout 9m] [--any] block until "Send to agent"; prints feedback
pp errors <session> [--all]              render errors waiting for you
pp feedback <session> [--open] [--batch N] [--since N] [--json]
pp reply <session> <id> "<text>"         reply (marks acknowledged)
pp resolve <session> <id>...             mark resolved
pp ack <session> <id>...                 mark acknowledged
pp close <session>                       status -> closed
pp rm <session>                          delete (or unregister an external dir)
pp version                               skill / host binary / running host versions
pp update [--check]                      update now instead of waiting for the background check
pp auto-update [on|off|status]           background self-update (release installs)
```
