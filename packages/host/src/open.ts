/**
 * Open a local path in the OS file manager: safely.
 *
 * Rules:
 * - The path must resolve (after symlinks) inside one of the session's
 *   `allowedRoots`. Everything else is refused.
 * - Directories are opened in the file manager. Files are *revealed* in their
 *   containing folder: never executed or handed to a default app.
 * - The OS tool is spawned with an argv array (no shell), so the path can't be
 *   interpreted as a command.
 */

import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

export interface OpenResult {
  ok: true;
  action: "open-dir" | "reveal-file";
  path: string;
}

export class OpenRefused extends Error {
  override name = "OpenRefused";
}

function isInside(root: string, target: string): boolean {
  const r = root.endsWith(sep) ? root : root + sep;
  const cmp = process.platform === "win32" ? (s: string) => s.toLowerCase() : (s: string) => s;
  return cmp(target) === cmp(root) || cmp(target).startsWith(cmp(r));
}

export async function resolveAllowed(path: string, allowedRoots: string[]): Promise<string> {
  if (!isAbsolute(path)) throw new OpenRefused(`path must be absolute: ${path}`);
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new OpenRefused(`path does not exist: ${path}`);
  }
  const roots = await Promise.all(
    allowedRoots.map(async (r) => {
      try {
        return await realpath(resolve(r));
      } catch {
        return null;
      }
    }),
  );
  const ok = roots.some((r) => r !== null && isInside(r, real));
  if (!ok) throw new OpenRefused(`path is outside the session's allowed roots: ${path}`);
  return real;
}

export async function openInFileManager(path: string, allowedRoots: string[]): Promise<OpenResult> {
  const real = await resolveAllowed(path, allowedRoots);
  const s = await stat(real);
  const isDir = s.isDirectory();
  const argv = commandFor(real, isDir);
  const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  // explorer.exe returns 1 even on success; don't await or inspect the code.
  proc.unref();
  return { ok: true, action: isDir ? "open-dir" : "reveal-file", path: real };
}

function commandFor(real: string, isDir: boolean): string[] {
  switch (process.platform) {
    case "win32":
      return isDir ? ["explorer.exe", real] : ["explorer.exe", `/select,${real}`];
    case "darwin":
      return isDir ? ["open", real] : ["open", "-R", real];
    default:
      // xdg-open has no "reveal"; open the parent directory for files.
      return ["xdg-open", isDir ? real : resolve(real, "..")];
  }
}
