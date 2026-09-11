// Release discovery, verified downloads, and the local install layout for the
// prebuilt host and the skill bundle. Dependency-free: runs from the skill.
//
// Layout under ~/.plan-presenter:
//   bin/<version>/pp-host-<os>-<arch>[.exe]   one directory per host version
//   bin/current.json                          { version, path, installedAt }
//   bin/pp-host-<os>-<arch>[.exe]             0.1.0-era location (still honoured)
//
// Versioned directories mean a running host (whose exe Windows keeps locked)
// is never overwritten; the next start simply uses the new path.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ppHome, readJson, replaceFile, samePath, skillDir, writeJsonAtomic } from "./_lib.ts";
import { readTarGz, safeArchivePath, type TarEntry } from "./_tar.ts";

export const REPO = "TomSawyerLabs/plan-presenter";
export const SKILL_ASSET = "plan-presenter-skill.tar.gz";

export function releaseBase(): string {
  return (process.env.PP_RELEASE_BASE ?? `https://github.com/${REPO}/releases`).replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface ReleaseAsset {
  sha256: string;
  size: number;
}

export interface ReleaseManifest {
  schema: number;
  name: string;
  version: string;
  tag: string;
  publishedAt: string;
  assets: Record<string, ReleaseAsset>;
}

export function manifestUrl(tag?: string): string {
  return tag
    ? `${releaseBase()}/download/${tag}/manifest.json`
    : `${releaseBase()}/latest/download/manifest.json`;
}

export function assetUrl(tag: string, name: string): string {
  return `${releaseBase()}/download/${tag}/${name}`;
}

export class ManifestUnavailable extends Error {
  override name = "ManifestUnavailable";
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Latest release manifest (via GitHub's latest/download redirect), or a specific tag's. */
export async function fetchManifest(tag?: string, timeoutMs = 20_000): Promise<ReleaseManifest> {
  const url = manifestUrl(tag);
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new ManifestUnavailable(`no release manifest at ${url} (HTTP ${res.status})`, res.status);
  }
  const m = (await res.json()) as Partial<ReleaseManifest>;
  if (typeof m.version !== "string" || typeof m.tag !== "string" || typeof m.assets !== "object") {
    throw new Error(`malformed release manifest at ${url}`);
  }
  return m as ReleaseManifest;
}

// ---------------------------------------------------------------------------
// Versions (semver precedence; keep in sync with packages/protocol/src/version.ts)
// ---------------------------------------------------------------------------

function parseVersion(v: string): { nums: number[]; pre: string[] | null } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : null };
}

/** Semver precedence. Unparseable versions (e.g. "dev") sort below everything. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) {
    const d = pa.nums[i]! - pb.nums[i]!;
    if (d) return Math.sign(d);
  }
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d) return Math.sign(d);
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

// ---------------------------------------------------------------------------
// Verified downloads
// ---------------------------------------------------------------------------

export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const reader = Bun.file(path).stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
  }
  return hasher.digest("hex");
}

/**
 * Stream `url` to `dest`, hashing as it goes. With `expected`, a sha256 or size
 * mismatch deletes the download and throws; `dest` is only replaced on success.
 */
export async function downloadVerified(
  url: string,
  dest: string,
  expected: ReleaseAsset | null,
  log: (s: string) => void = () => {},
): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.download`;
  log(`downloading ${url}`);
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const hasher = new Bun.CryptoHasher("sha256");
  const sink = Bun.file(tmp).writer();
  let size = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
      sink.write(value);
      size += value.length;
    }
    await sink.flush();
    await sink.end();
  } catch (err) {
    try {
      await sink.end();
    } catch {
      /* already closed */
    }
    rmSync(tmp, { force: true });
    throw err;
  }
  const digest = hasher.digest("hex");
  if (expected && (digest !== expected.sha256 || size !== expected.size)) {
    rmSync(tmp, { force: true });
    throw new Error(
      `checksum mismatch for ${url}: got sha256 ${digest} (${size} bytes), ` +
        `expected ${expected.sha256} (${expected.size} bytes)`,
    );
  }
  replaceFile(tmp, dest);
}

// ---------------------------------------------------------------------------
// Host binaries
// ---------------------------------------------------------------------------

/** `linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`, `windows-x64`. */
export function platformKey(): string {
  const os =
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${os}-${arch}`;
}

export function hostBinaryName(): string {
  return `pp-host-${platformKey()}${process.platform === "win32" ? ".exe" : ""}`;
}

export function binRoot(): string {
  return join(ppHome(), "bin");
}

export function legacyHostBinaryPath(): string {
  return join(binRoot(), hostBinaryName());
}

export interface CurrentHost {
  version: string;
  path: string;
  installedAt: string;
}

function currentJsonPath(): string {
  return join(binRoot(), "current.json");
}

export function readCurrentHost(): CurrentHost | null {
  const c = readJson<CurrentHost>(currentJsonPath());
  return c && typeof c.path === "string" && existsSync(c.path) ? c : null;
}

export function setCurrentHost(version: string, path: string): CurrentHost {
  const c: CurrentHost = { version, path: resolve(path), installedAt: new Date().toISOString() };
  writeJsonAtomic(currentJsonPath(), c);
  return c;
}

/** The binary `pp serve` should run: current.json, else the 0.1.0-era location. */
export function currentHostBinary(): string | null {
  const c = readCurrentHost();
  if (c) return c.path;
  const legacy = legacyHostBinaryPath();
  return existsSync(legacy) ? legacy : null;
}

/** Installed version directories, newest first. */
export function installedHostVersions(): Array<{ version: string; path: string }> {
  if (!existsSync(binRoot())) return [];
  const out: Array<{ version: string; path: string }> = [];
  for (const name of readdirSync(binRoot())) {
    const path = join(binRoot(), name, hostBinaryName());
    if (existsSync(path)) out.push({ version: name, path });
  }
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

/** The newest installed host other than `exclude`, for rollback. */
export function previousHostBinary(exclude: string): { version: string; path: string } | null {
  return installedHostVersions().find((v) => !samePath(v.path, exclude)) ?? null;
}

/** Keep the current host and the newest other one (rollback); remove the rest when possible. */
export function pruneHostBinaries(current: CurrentHost, keep = 2): void {
  const versions = installedHostVersions();
  const others = versions.filter((v) => !samePath(v.path, current.path)).slice(0, keep - 1);
  const keepPaths = [current.path, ...others.map((v) => v.path)];
  for (const v of versions) {
    if (keepPaths.some((k) => samePath(k, v.path))) continue;
    try {
      rmSync(dirname(v.path), { recursive: true, force: true });
    } catch {
      /* still running; the next prune gets it */
    }
  }
  const legacy = legacyHostBinaryPath();
  if (existsSync(legacy) && !samePath(legacy, current.path)) {
    try {
      rmSync(legacy, { force: true });
    } catch {
      /* a 0.1.0 host is still running from it */
    }
  }
}

/** Download (if needed) and select the host binary from a release manifest. */
export async function installHostBinary(
  manifest: ReleaseManifest,
  log: (s: string) => void = () => {},
): Promise<CurrentHost> {
  const name = hostBinaryName();
  const asset = manifest.assets[name];
  if (!asset) throw new Error(`release ${manifest.tag} has no ${name}`);
  const dest = join(binRoot(), manifest.version, name);
  const present =
    existsSync(dest) &&
    statSync(dest).size === asset.size &&
    (await sha256File(dest)) === asset.sha256;
  if (!present) await downloadVerified(assetUrl(manifest.tag, name), dest, asset, log);
  if (process.platform !== "win32") chmodSync(dest, 0o755);
  const current = setCurrentHost(manifest.version, dest);
  pruneHostBinaries(current);
  log(`host ${manifest.version} ready at ${dest}`);
  return current;
}

/** For releases published before manifests existed (0.1.0): nothing to verify against. */
export async function installHostBinaryUnverified(
  tag: string,
  log: (s: string) => void = () => {},
): Promise<CurrentHost> {
  const name = hostBinaryName();
  const url = tag === "latest" ? `${releaseBase()}/latest/download/${name}` : assetUrl(tag, name);
  const dest = join(binRoot(), `unverified-${tag.replace(/^v/, "")}`, name);
  log(`warning: release ${tag} has no manifest; downloading without checksum verification`);
  await downloadVerified(url, dest, null, log);
  if (process.platform !== "win32") chmodSync(dest, 0o755);
  return setCurrentHost((await binaryVersion(dest)) ?? tag, dest);
}

/** Run `<bin> --version` and return the printed version, or null. */
export async function binaryVersion(bin: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "ignore" });
    const text = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return text || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Skill bundle
// ---------------------------------------------------------------------------

export interface SkillInfo {
  version: string;
  /** "release": installed from a release tarball, self-updates. "dev": follows a checkout. */
  channel: "release" | "dev";
  files: string[];
  dir: string;
}

export function skillInfo(dir: string = skillDir()): SkillInfo {
  const j = readJson<{ version?: unknown; channel?: unknown; files?: unknown }>(
    join(dir, "version.json"),
  );
  if (!j) return { version: "dev", channel: "dev", files: [], dir };
  return {
    version: typeof j.version === "string" ? j.version : "0.0.0",
    channel: j.channel === "release" ? "release" : "dev",
    files: Array.isArray(j.files) ? j.files.filter((f): f is string => typeof f === "string") : [],
    dir,
  };
}

export async function installSkillBundle(
  manifest: ReleaseManifest,
  dir: string,
  log: (s: string) => void = () => {},
): Promise<{ written: number; removed: string[] }> {
  const asset = manifest.assets[SKILL_ASSET];
  if (!asset) throw new Error(`release ${manifest.tag} has no ${SKILL_ASSET}`);
  const tmp = join(ppHome(), "tmp", `skill-${manifest.version}-${process.pid}.tar.gz`);
  await downloadVerified(assetUrl(manifest.tag, SKILL_ASSET), tmp, asset, log);
  try {
    return applySkillBundle(readTarGz(readFileSync(tmp)), dir, manifest.version);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Write a skill bundle over an installed skill directory. Every file goes
 * through temp + rename; version.json is written last, so an interrupted
 * update leaves the old version recorded and is simply retried.
 */
export function applySkillBundle(
  entries: TarEntry[],
  dir: string,
  expectedVersion?: string,
): { written: number; removed: string[] } {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const vj = byPath.get("version.json");
  if (!vj) throw new Error("skill bundle has no version.json");
  const next = JSON.parse(new TextDecoder().decode(vj.data)) as { version?: string };
  if (expectedVersion && next.version !== expectedVersion) {
    throw new Error(`skill bundle is ${next.version}, expected ${expectedVersion}`);
  }
  for (const required of ["SKILL.md", "scripts/pp.ts"]) {
    if (!byPath.has(required)) throw new Error(`skill bundle is missing ${required}`);
  }
  const prev = skillInfo(dir);
  let written = 0;
  for (const e of entries) {
    if (e.path === "version.json") continue;
    const dest = join(dir, e.path);
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.pp-new`;
    writeFileSync(tmp, e.data);
    replaceFile(tmp, dest);
    written++;
  }
  const shipped = new Set(entries.map((e) => e.path));
  const removed: string[] = [];
  for (const f of prev.files) {
    if (shipped.has(f)) continue;
    try {
      rmSync(join(dir, safeArchivePath(f)), { force: true });
      removed.push(f);
    } catch {
      /* leave it */
    }
  }
  const tmp = join(dir, "version.json.pp-new");
  writeFileSync(tmp, vj.data);
  replaceFile(tmp, join(dir, "version.json"));
  return { written, removed };
}
