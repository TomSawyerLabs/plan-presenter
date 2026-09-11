#!/usr/bin/env bun
/**
 * Package the agent skill for a release.
 *
 *   bun run scripts/package-skill.ts --out dist/plan-presenter-skill.tar.gz [--version 0.2.0]
 *
 * Contents: SKILL.md, reference/**, scripts/** (minus install.ts, which needs a
 * checkout) and a generated version.json:
 *
 *   { "version": "0.2.0", "channel": "release", "files": [...] }
 *
 * `channel: "release"` is what enables self-update on the installed copy; the
 * `files` list lets the updater remove files that a later version dropped.
 * The archive is written with our own reproducible ustar writer, so it does not
 * depend on which `tar` a runner happens to have.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { writeTarGz } from "../skill/scripts/_tar.ts";

const repo = resolve(import.meta.dir, "..");
const skillDir = join(repo, "skill");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

const out = resolve(arg("out") ?? join(repo, "dist", "plan-presenter-skill.tar.gz"));
const version =
  arg("version") ??
  (JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string }).version;

const included = [
  join(skillDir, "SKILL.md"),
  ...listFiles(join(skillDir, "reference")),
  ...listFiles(join(skillDir, "scripts")).filter((p) => !p.endsWith("install.ts")),
]
  .map((abs) => ({ abs, rel: relative(skillDir, abs).split("\\").join("/") }))
  .sort((a, b) => a.rel.localeCompare(b.rel));

const files = included.map((f) => f.rel);
const versionJson = `${JSON.stringify({ version, channel: "release", files }, null, 2)}\n`;

const archive = writeTarGz([
  ...included.map((f) => ({ path: f.rel, data: readFileSync(f.abs) })),
  { path: "version.json", data: new TextEncoder().encode(versionJson) },
]);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, archive);
console.log(`packaged skill ${version} (${files.length} files + version.json) -> ${out}`);
