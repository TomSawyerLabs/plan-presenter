/**
 * Where the built UI comes from: a directory on disk (dev, desktop bundle) or
 * files embedded in the compiled host binary.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BunFile } from "bun";
import { embeddedUi } from "./embedded-ui.ts";

export interface UiFiles {
  /** Human-readable origin for logs. */
  readonly description: string;
  /** Resolve a URL path (no leading slash) to a file, or null if absent. */
  get(rel: string): BunFile | null;
}

export function uiFilesFromDir(dir: string): UiFiles | null {
  const abs = resolve(dir);
  if (!existsSync(join(abs, "index.html"))) return null;
  return {
    description: abs,
    get(rel) {
      const candidate = resolve(abs, rel);
      if (!candidate.startsWith(abs) || !existsSync(candidate)) return null;
      const f = Bun.file(candidate);
      return f.size > 0 || rel === "index.html" ? f : null;
    },
  };
}

export function uiFilesFromEmbedded(): UiFiles | null {
  if (!embeddedUi["index.html"]) return null;
  return {
    description: "embedded",
    get(rel) {
      const path = embeddedUi[rel];
      return path ? Bun.file(path) : null;
    },
  };
}

/** Embedded first (compiled binary), then the given directories in order. */
export function resolveUiFiles(dirs: Array<string | undefined>): UiFiles | null {
  const embedded = uiFilesFromEmbedded();
  if (embedded) return embedded;
  for (const d of dirs) {
    if (!d) continue;
    const files = uiFilesFromDir(d);
    if (files) return files;
  }
  return null;
}
