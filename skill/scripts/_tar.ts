// Minimal, dependency-free tar reader/writer for the skill bundle.
//
// The skill must run on a plain Bun install with no node_modules, and Bun
// 1.3.0 has no Bun.Archive, so the self-updater carries its own tar support.
// Reader: ustar (name + prefix), GNU long names ('L'), pax headers ('x').
// Writer: plain ustar with fixed mtime/uid/gid, so packaging is reproducible.

export interface TarEntry {
  path: string;
  data: Uint8Array;
  mode: number;
}

const BLOCK = 512;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function field(buf: Uint8Array, off: number, len: number): string {
  const slice = buf.subarray(off, off + len);
  const nul = slice.indexOf(0);
  return decoder.decode(nul === -1 ? slice : slice.subarray(0, nul));
}

function octal(buf: Uint8Array, off: number, len: number): number {
  // GNU base-256 encoding for large numbers: high bit of the first byte set.
  if (buf[off]! & 0x80) {
    let n = buf[off]! & 0x7f;
    for (let i = off + 1; i < off + len; i++) n = n * 256 + buf[i]!;
    return n;
  }
  const s = field(buf, off, len).trim();
  return s ? Number.parseInt(s, 8) : 0;
}

function checksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  return sum;
}

/** Parse pax extended-header records: "<len> key=value\n", lengths in bytes. */
function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const len = Number.parseInt(decoder.decode(data.subarray(i, sp)), 10);
    if (!len || len <= 0) break;
    const record = data.subarray(sp + 1, i + len - 1); // drop trailing "\n"
    const eq = record.indexOf(0x3d); // "="
    if (eq > 0)
      out[decoder.decode(record.subarray(0, eq))] = decoder.decode(record.subarray(eq + 1));
    i += len;
  }
  return out;
}

/** Normalise an archive path and refuse anything that could escape the target dir. */
export function safeArchivePath(raw: string): string {
  const p = raw.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  if (!p || p.startsWith("/") || /^[A-Za-z]:/.test(p)) {
    throw new Error(`unsafe path in archive: ${JSON.stringify(raw)}`);
  }
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.some((s) => s === ".."))
    throw new Error(`unsafe path in archive: ${JSON.stringify(raw)}`);
  return parts.join("/");
}

/** Read regular files from an uncompressed tar. Directories, links, etc. are skipped. */
export function readTar(tar: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let off = 0;
  let longName: string | null = null;
  let pax: Record<string, string> | null = null;
  while (off + BLOCK <= tar.length) {
    const header = tar.subarray(off, off + BLOCK);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    if (checksum(header) !== octal(header, 148, 8)) {
      throw new Error(`corrupt tar: bad header checksum at offset ${off}`);
    }
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156]!);
    const start = off + BLOCK;
    if (start + size > tar.length) throw new Error("corrupt tar: truncated entry");
    const data = tar.subarray(start, start + size);
    off = start + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "L") {
      longName = field(data, 0, data.length);
      continue;
    }
    if (type === "x") {
      pax = parsePax(data);
      continue;
    }
    if (type === "g" || type === "K") continue;

    let name = field(header, 0, 100);
    // POSIX ustar ("ustar\0") has a name prefix at 345; old GNU format
    // ("ustar  ") keeps atime/ctime there instead and uses 'L' for long names.
    if (field(header, 257, 5) === "ustar" && header[262] === 0) {
      const prefix = field(header, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    if (longName !== null) name = longName;
    if (pax?.path) name = pax.path;
    longName = null;
    pax = null;

    if (type === "0" || type === "\0" || type === "7") {
      entries.push({
        path: safeArchivePath(name),
        data: data.slice(),
        mode: octal(header, 100, 8),
      });
    }
  }
  return entries;
}

export function readTarGz(gz: Uint8Array): TarEntry[] {
  return readTar(Bun.gunzipSync(new Uint8Array(gz)));
}

function writeField(header: Uint8Array, off: number, len: number, value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.length > len) throw new Error(`tar field too long: ${value}`);
  header.set(bytes, off);
}

function writeOctal(header: Uint8Array, off: number, len: number, value: number): void {
  writeField(header, off, len, `${value.toString(8).padStart(len - 1, "0")}\0`);
}

/** Split a path into ustar name (<=100) and prefix (<=155) at a "/" boundary. */
function splitUstarPath(path: string): { name: string; prefix: string } {
  if (encoder.encode(path).length <= 100) return { name: path, prefix: "" };
  for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (encoder.encode(name).length <= 100 && encoder.encode(prefix).length <= 155) {
      return { name, prefix };
    }
  }
  throw new Error(`path too long for ustar: ${path}`);
}

/** Write a reproducible ustar archive (mtime 0, uid/gid 0, mode 0644 unless given). */
export function writeTar(
  files: Array<{ path: string; data: Uint8Array; mode?: number }>,
): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  for (const f of files) {
    const header = new Uint8Array(BLOCK);
    const { name, prefix } = splitUstarPath(f.path);
    writeField(header, 0, 100, name);
    writeOctal(header, 100, 8, f.mode ?? 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, f.data.length);
    writeOctal(header, 136, 12, 0);
    header[156] = 0x30; // "0" regular file
    writeField(header, 257, 6, "ustar\0");
    writeField(header, 263, 2, "00");
    writeField(header, 345, 155, prefix);
    writeField(header, 148, 8, `${checksum(header).toString(8).padStart(6, "0")}\0 `);
    chunks.push(header, f.data);
    const pad = (BLOCK - (f.data.length % BLOCK)) % BLOCK;
    if (pad) chunks.push(new Uint8Array(pad));
  }
  chunks.push(new Uint8Array(BLOCK * 2));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export function writeTarGz(
  files: Array<{ path: string; data: Uint8Array; mode?: number }>,
): Uint8Array {
  return Bun.gzipSync(writeTar(files), { level: 9 });
}
