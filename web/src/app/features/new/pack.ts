import { gzipSync, unzipSync } from 'fflate';
import type { Detected, DetectionRule } from '../../core/api.types';

/**
 * Turning what was dropped into what the server takes (ADR-0015): ONE tar.gz. Files,
 * folders and zips are all flattened here, in the browser -- the server keeps one hardened
 * archive reader, and zip (its directory is at the END of the file) cannot be read
 * streaming, so it never reaches the server as a zip.
 *
 * Everything below `collect*` is pure and synchronous, and unit-tested as such.
 */

export type UploadFile = { path: string; data: Uint8Array };
export type Collected = { files: UploadFile[]; totalBytes: number; skipped: number; name: string | null };

/** Client-side cap. The server enforces its own (larger) limits; this one fails fast and says why. */
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 20_000;

export class UploadError extends Error {}

const mib = (n: number) => `${Math.round((n / 1024 / 1024) * 10) / 10} MiB`;

/** Things no preview wants: OS litter, a VCS, and dependencies the runtime reinstalls. */
const JUNK_SEGMENTS = new Set(['__MACOSX', '.git', 'node_modules']);
const JUNK_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

export function isJunk(path: string): boolean {
  const parts = path.split('/');
  return parts.some((p) => JUNK_SEGMENTS.has(p)) || JUNK_NAMES.has(parts[parts.length - 1] ?? '') || (parts[parts.length - 1] ?? '').startsWith('._');
}

/** A relative, forward-slash path with no `.`/`..` segments -- or an error that names it. */
export function normalizePath(raw: string): string {
  const parts = raw.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) throw new UploadError(`"${raw}" points outside the upload`);
  if (parts.length === 0) throw new UploadError(`"${raw}" is not a file path`);
  return parts.join('/');
}

/**
 * A folder dropped whole, or a zip of one, puts every path under the same first segment.
 * The server looks for markers (package.json, index.html) at the ROOT, so that one segment
 * is removed -- and remembered, as a name for the preview.
 */
export function stripCommonRoot<T extends { path: string }>(files: T[]): { files: T[]; root: string | null } {
  if (files.length === 0) return { files, root: null };
  const first = files[0]!.path.split('/')[0]!;
  const shared = files.every((f) => f.path.includes('/') && f.path.split('/')[0] === first);
  if (!shared) return { files, root: null };
  return { files: files.map((f) => ({ ...f, path: f.path.slice(first.length + 1) })), root: first };
}

/** Exactly the server's `detectRuntime` (shared/src/runtimes.ts), over the rules it sends. */
export function detect(paths: Iterable<string>, rules: readonly DetectionRule[]): Detected {
  const have = new Set(paths);
  for (const rule of rules) if (rule.markers.some((m) => have.has(m))) return rule.runtime;
  return 'static';
}

export const isZip = (name: string) => /\.zip$/i.test(name);

/** The entries of a zip, directories dropped. */
export function unzip(bytes: Uint8Array): UploadFile[] {
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(bytes); }
  catch { throw new UploadError('That zip could not be read. Is it a complete .zip file?'); }
  return Object.entries(entries).filter(([name]) => !name.endsWith('/')).map(([name, data]) => ({ path: name, data }));
}

/**
 * Cleans and checks a raw list: normalises paths, drops junk, strips one common root,
 * refuses duplicates and anything over the caps.
 */
export function finish(raw: UploadFile[], fallbackName: string | null = null): Collected {
  const kept: UploadFile[] = [];
  let skipped = 0;
  for (const f of raw) {
    const path = normalizePath(f.path);
    if (isJunk(path)) { skipped++; continue; }
    kept.push({ path, data: f.data });
  }
  const { files, root } = stripCommonRoot(kept);
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const f of files) {
    if (seen.has(f.path)) throw new UploadError(`"${f.path}" appears twice`);
    seen.add(f.path);
    totalBytes += f.data.byteLength;
  }
  if (files.length > MAX_UPLOAD_FILES) throw new UploadError(`That is ${files.length} files; the limit is ${MAX_UPLOAD_FILES}.`);
  if (totalBytes > MAX_UPLOAD_BYTES) throw new UploadError(`That is ${mib(totalBytes)}; uploads are limited to ${mib(MAX_UPLOAD_BYTES)}.`);
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), totalBytes, skipped, name: root ?? fallbackName };
}

/* ------------------------------------------------------------------ tar */

const enc = new TextEncoder();

function field(h: Uint8Array, offset: number, length: number, value: string): void {
  const b = enc.encode(value);
  h.set(b.subarray(0, length), offset);
}
const octal = (n: number, length: number) => n.toString(8).padStart(length - 1, '0');

/** ustar splits a long path into `prefix/name`: name <= 100 bytes, prefix <= 155. */
function splitPath(path: string): { name: string; prefix: string } {
  if (enc.encode(path).length <= 100) return { name: path, prefix: '' };
  for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
    const prefix = path.slice(0, i), name = path.slice(i + 1);
    if (enc.encode(prefix).length <= 155 && enc.encode(name).length <= 100 && name !== '') return { name, prefix };
  }
  throw new UploadError(`"${path}" is too long a path for an upload (255 bytes at most, with no file name over 100)`);
}

function header(path: string, size: number, type: '0', mode: number, mtime: number): Uint8Array {
  const h = new Uint8Array(512);
  const { name, prefix } = splitPath(path);
  field(h, 0, 100, name);
  field(h, 100, 8, octal(mode, 8));
  field(h, 108, 8, octal(0, 8));
  field(h, 116, 8, octal(0, 8));
  field(h, 124, 12, octal(size, 12));
  field(h, 136, 12, octal(mtime, 12));
  field(h, 148, 8, '        '); // checksum is computed over spaces here
  field(h, 156, 1, type);
  field(h, 257, 6, 'ustar\0');
  field(h, 263, 2, '00');
  field(h, 345, 155, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  field(h, 148, 8, `${octal(sum, 7)}\0`);
  return h;
}

/**
 * A ustar archive of regular files, owned by 0:0, 0644. No directory entries: the server's
 * extractor creates (and checks) every parent itself, and a directory entry would only
 * add a second way to be too long.
 */
export function writeTar(files: readonly UploadFile[], mtime = Math.floor(Date.now() / 1000)): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const f of files) {
    parts.push(header(f.path, f.data.byteLength, '0', 0o644, mtime));
    parts.push(f.data);
    const pad = (512 - (f.data.byteLength % 512)) % 512;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024)); // two zero blocks end the archive
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

export function packFiles(files: readonly UploadFile[]): Blob {
  const gz = gzipSync(writeTar(files), { level: 6 });
  return new Blob([gz as Uint8Array<ArrayBuffer>], { type: 'application/gzip' });
}

/** A runtime's starter (path -> text) as an upload. */
export function packStarter(starter: Record<string, string>): Blob {
  return packFiles(Object.entries(starter).map(([path, text]) => ({ path: normalizePath(path), data: enc.encode(text) })));
}

/* ------------------------------------------------------------------ collecting from the browser */

async function bytesOf(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/** A file, or a zip's contents placed under its own name (so strip-root sees one folder). */
async function expand(path: string, file: File, raw: UploadFile[], budget: { bytes: number }): Promise<void> {
  budget.bytes += file.size;
  if (budget.bytes > MAX_UPLOAD_BYTES * 2) throw new UploadError(`That is more than ${mib(MAX_UPLOAD_BYTES)}; uploads are limited to that.`);
  const data = await bytesOf(file);
  if (isZip(path)) {
    const inside = unzip(data);
    const base = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    for (const e of inside) raw.push({ path: base + e.path, data: e.data });
  } else {
    raw.push({ path, data });
  }
}

/** Only a single zip dropped on its own names the preview after the zip; a folder names it after itself. */
const zipName = (files: readonly File[]) => (files.length === 1 && isZip(files[0]!.name) ? files[0]!.name.replace(/\.zip$/i, '') : null);

/** From `<input type=file multiple>` (or `webkitdirectory`, whose files carry `webkitRelativePath`). */
export async function collectFromFiles(list: readonly File[]): Promise<Collected> {
  const raw: UploadFile[] = [];
  const budget = { bytes: 0 };
  for (const f of list) await expand(f.webkitRelativePath || f.name, f, raw, budget);
  return finish(raw, zipName(list));
}

type Entry = { isFile: boolean; isDirectory: boolean; name: string; fullPath: string };
type FileEntry = Entry & { file(ok: (f: File) => void, err: (e: unknown) => void): void };
type DirEntry = Entry & { createReader(): { readEntries(ok: (e: Entry[]) => void, err: (e: unknown) => void): void } };

async function walk(entry: Entry, prefix: string, out: { path: string; file: File }[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((ok, err) => (entry as FileEntry).file(ok, err));
    out.push({ path: prefix + entry.name, file });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as DirEntry).createReader();
  // readEntries returns a batch at a time (100 in Chrome) until it returns none.
  for (;;) {
    const batch = await new Promise<Entry[]>((ok, err) => reader.readEntries(ok, err));
    if (batch.length === 0) break;
    for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
  }
}

/** From a drop: files, whole folders (walked), and zips (expanded). */
export async function collectFromDrop(dt: DataTransfer): Promise<Collected> {
  const entries: Entry[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue;
    const e = (item as DataTransferItem & { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.();
    if (e) entries.push(e);
  }
  // No entry API (or a synthetic drop): the flat file list is all there is.
  if (entries.length === 0) return collectFromFiles(Array.from(dt.files ?? []));

  const found: { path: string; file: File }[] = [];
  for (const e of entries) await walk(e, '', found);
  const raw: UploadFile[] = [];
  const budget = { bytes: 0 };
  for (const f of found) await expand(f.path, f.file, raw, budget);
  return finish(raw, zipName(found.map((f) => f.file)));
}
