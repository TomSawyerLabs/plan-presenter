#!/usr/bin/env bun
/**
 * Install the plan-presenter skill for Claude Code (or any agent that reads
 * SKILL.md directories) from this checkout.
 *
 *   bun run skill/scripts/install.ts            -> ~/.claude/skills/plan-presenter
 *   bun run skill/scripts/install.ts --project  -> ./.claude/skills/plan-presenter (cwd)
 *   bun run skill/scripts/install.ts --to DIR   -> DIR/plan-presenter
 *
 * This is a *dev* install: it records the repo location in
 * ~/.plan-presenter/config.json so `pp serve` runs the host from source, and
 * marks the copy `channel: "dev"` so it never self-updates from releases.
 * Release installs come from the release tarball instead (see README).
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, parseArgv, saveConfig, skillDir, str } from "./_lib.ts";

const { flags } = parseArgv(process.argv.slice(2));
const repoDir = resolve(skillDir(), "..");
const target = str(flags.to)
  ? join(resolve(String(flags.to)), "plan-presenter")
  : flags.project
    ? join(process.cwd(), ".claude", "skills", "plan-presenter")
    : join(homedir(), ".claude", "skills", "plan-presenter");

if (!existsSync(join(repoDir, "packages", "host", "src", "cli.ts"))) {
  console.error(`install.ts must run from the plan-presenter repo (got ${repoDir})`);
  process.exit(1);
}

// 1. Build the UI if needed.
const dist = join(repoDir, "packages", "ui", "dist", "index.html");
if (!existsSync(dist) || flags.build) {
  console.log("building UI…");
  const r = Bun.spawnSync(["bun", "run", "build"], {
    cwd: repoDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (r.exitCode !== 0) process.exit(r.exitCode);
}

// 2. Copy the skill bundle.
if (existsSync(target)) rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(join(skillDir(), "SKILL.md"), join(target, "SKILL.md"));
cpSync(join(skillDir(), "scripts"), join(target, "scripts"), {
  recursive: true,
  filter: (src) => !src.endsWith("install.ts"),
});
cpSync(join(skillDir(), "reference"), join(target, "reference"), { recursive: true });

// 3. Mark the copy as a dev install: it follows this checkout, never self-updates.
const version = (
  JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8")) as { version: string }
).version;
writeFileSync(
  join(target, "version.json"),
  `${JSON.stringify({ version, channel: "dev", repoDir }, null, 2)}\n`,
);

// 4. Record the repo dir for `pp serve`.
saveConfig({ ...loadConfig(), repoDir });

console.log(`installed skill ${version} (dev) to ${target}`);
console.log(`recorded repoDir=${repoDir} in ~/.plan-presenter/config.json`);
console.log(`\nTry: bun run ${join(target, "scripts", "pp.ts")} serve`);
