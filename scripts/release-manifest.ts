#!/usr/bin/env bun
/**
 * Write the release manifest that auto-updating clients read.
 *
 *   bun run scripts/release-manifest.ts --dir dist --tag v0.2.0
 *
 * Produces <dir>/manifest.json:
 *
 *   { "schema": 1, "name": "plan-presenter", "version": "0.2.0", "tag": "v0.2.0",
 *     "publishedAt": "...", "assets": { "<file>": { "sha256": "...", "size": 123 } } }
 *
 * Clients fetch `releases/latest/download/manifest.json`, then download assets
 * from the pinned tag and verify sha256 + size before installing.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const dir = resolve(arg("dir") ?? "dist");
const tag = arg("tag");
if (!tag || !/^v\d+\.\d+\.\d+/.test(tag)) {
  console.error("usage: release-manifest.ts --dir <dist> --tag vX.Y.Z");
  process.exit(1);
}
const version = tag.slice(1);
const pkgVersion = (
  JSON.parse(readFileSync(resolve(import.meta.dir, "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;
if (pkgVersion !== version) {
  console.error(`tag ${tag} does not match package.json version ${pkgVersion}`);
  process.exit(1);
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const reader = Bun.file(path).stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
  }
  return hasher.digest("hex");
}

const assets: Record<string, { sha256: string; size: number }> = {};
for (const name of readdirSync(dir).sort()) {
  if (name === "manifest.json") continue;
  const path = join(dir, name);
  const st = statSync(path);
  if (!st.isFile()) continue;
  assets[name] = { sha256: await sha256(path), size: st.size };
}

const manifest = {
  schema: 1,
  name: "plan-presenter",
  version,
  tag,
  publishedAt: new Date().toISOString(),
  assets,
};
writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`manifest for ${tag}: ${Object.keys(assets).length} assets`);
