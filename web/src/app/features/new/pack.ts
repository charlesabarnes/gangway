import { gzipSync, unzipSync } from 'fflate';
import type { Detected, DetectionRule } from '../../core/api.types';

export type UploadFile = { path: string; data: Uint8Array };
export type Collected = {
  files: UploadFile[];
  totalBytes: number;
  skipped: number;
  name: string | null;
};

export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 20_000;

export class UploadError extends Error {}

const mib = (n: number) => `${Math.round((n / 1024 / 1024) * 10) / 10} MiB`;

const JUNK_SEGMENTS = new Set(['__MACOSX', '.git', 'node_modules']);
const JUNK_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

export function isJunk(path: string): boolean {
  const parts = path.split('/');
  return (
    parts.some((p) => JUNK_SEGMENTS.has(p)) ||
    JUNK_NAMES.has(parts[parts.length - 1] ?? '') ||
    (parts[parts.length - 1] ?? '').startsWith('._')
  );
}

export function normalizePath(raw: string): string {
  const parts = raw
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) throw new UploadError(`"${raw}" points outside the upload`);
  if (parts.length === 0) throw new UploadError(`"${raw}" is not a file path`);
  return parts.join('/');
}

export function stripCommonRoot<T extends { path: string }>(
  files: T[],
): { files: T[]; root: string | null } {
  if (files.length === 0) return { files, root: null };
  const first = files[0]!.path.split('/')[0]!;
  const shared = files.every((f) => f.path.includes('/') && f.path.split('/')[0] === first);
  if (!shared) return { files, root: null };
  return { files: files.map((f) => ({ ...f, path: f.path.slice(first.length + 1) })), root: first };
}

export function detect(paths: Iterable<string>, rules: readonly DetectionRule[]): Detected {
  const have = new Set(paths);
  for (const rule of rules) if (rule.markers.some((m) => have.has(m))) return rule.runtime;
  return 'static';
}

export const isZip = (name: string) => /\.zip$/i.test(name);

export const MAX_PLAN_FILE_BYTES = 256 * 1024;

export function planPayload(
  files: readonly UploadFile[],
  planFiles: readonly string[],
): { paths: string[]; files: Record<string, string> } {
  const names = new Set(planFiles);
  const contents: Record<string, string> = {};
  for (const f of files) {
    const parts = f.path.split('/');
    if (
      parts.length > 2 ||
      !names.has(parts[parts.length - 1]!) ||
      f.data.byteLength > MAX_PLAN_FILE_BYTES
    )
      continue;
    try {
      contents[f.path] = new TextDecoder('utf-8', { fatal: true }).decode(f.data);
    } catch {
      /* not text: named only */
    }
  }
  return { paths: files.map((f) => f.path), files: contents };
}

export function unzip(bytes: Uint8Array): UploadFile[] {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new UploadError('That zip could not be read. Is it a complete .zip file?');
  }
  return Object.entries(entries)
    .filter(([name]) => !name.endsWith('/'))
    .map(([name, data]) => ({ path: name, data }));
}

export function finish(raw: UploadFile[], fallbackName: string | null = null): Collected {
  const kept: UploadFile[] = [];
  let skipped = 0;
  for (const f of raw) {
    const path = normalizePath(f.path);
    if (isJunk(path)) {
      skipped++;
      continue;
    }
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
  if (files.length > MAX_UPLOAD_FILES)
    throw new UploadError(`That is ${files.length} files; the limit is ${MAX_UPLOAD_FILES}.`);
  if (totalBytes > MAX_UPLOAD_BYTES)
    throw new UploadError(
      `That is ${mib(totalBytes)}; uploads are limited to ${mib(MAX_UPLOAD_BYTES)}.`,
    );
  return {
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    totalBytes,
    skipped,
    name: root ?? fallbackName,
  };
}

const enc = new TextEncoder();

function field(h: Uint8Array, offset: number, length: number, value: string): void {
  const b = enc.encode(value);
  h.set(b.subarray(0, length), offset);
}
const octal = (n: number, length: number) => n.toString(8).padStart(length - 1, '0');

function splitPath(path: string): { name: string; prefix: string } {
  if (enc.encode(path).length <= 100) return { name: path, prefix: '' };
  for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
    const prefix = path.slice(0, i),
      name = path.slice(i + 1);
    if (enc.encode(prefix).length <= 155 && enc.encode(name).length <= 100 && name !== '')
      return { name, prefix };
  }
  throw new UploadError(
    `"${path}" is too long a path for an upload (255 bytes at most, with no file name over 100)`,
  );
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
  // The checksum is summed with its own field filled with spaces.
  field(h, 148, 8, '        ');
  field(h, 156, 1, type);
  field(h, 257, 6, 'ustar\0');
  field(h, 263, 2, '00');
  field(h, 345, 155, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  field(h, 148, 8, `${octal(sum, 7)}\0`);
  return h;
}

export function writeTar(
  files: readonly UploadFile[],
  mtime = Math.floor(Date.now() / 1000),
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const f of files) {
    parts.push(header(f.path, f.data.byteLength, '0', 0o644, mtime));
    parts.push(f.data);
    const pad = (512 - (f.data.byteLength % 512)) % 512;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

export function packFiles(files: readonly UploadFile[]): Blob {
  const gz = gzipSync(writeTar(files), { level: 6 });
  return new Blob([gz as Uint8Array<ArrayBuffer>], { type: 'application/gzip' });
}

export function packStarter(starter: Record<string, string>): Blob {
  return packFiles(
    Object.entries(starter).map(([path, text]) => ({
      path: normalizePath(path),
      data: enc.encode(text),
    })),
  );
}

async function bytesOf(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

async function expand(
  path: string,
  file: File,
  raw: UploadFile[],
  budget: { bytes: number },
): Promise<void> {
  budget.bytes += file.size;
  if (budget.bytes > MAX_UPLOAD_BYTES * 2)
    throw new UploadError(
      `That is more than ${mib(MAX_UPLOAD_BYTES)}; uploads are limited to that.`,
    );
  const data = await bytesOf(file);
  if (isZip(path)) {
    const inside = unzip(data);
    const base = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    for (const e of inside) raw.push({ path: base + e.path, data: e.data });
  } else {
    raw.push({ path, data });
  }
}

const zipName = (files: readonly File[]) =>
  files.length === 1 && isZip(files[0]!.name) ? files[0]!.name.replace(/\.zip$/i, '') : null;

export async function collectFromFiles(list: readonly File[]): Promise<Collected> {
  const raw: UploadFile[] = [];
  const budget = { bytes: 0 };
  for (const f of list) await expand(f.webkitRelativePath || f.name, f, raw, budget);
  return finish(raw, zipName(list));
}

type Entry = { isFile: boolean; isDirectory: boolean; name: string; fullPath: string };
type FileEntry = Entry & { file(ok: (f: File) => void, err: (e: unknown) => void): void };
type DirEntry = Entry & {
  createReader(): { readEntries(ok: (e: Entry[]) => void, err: (e: unknown) => void): void };
};

async function walk(
  entry: Entry,
  prefix: string,
  out: { path: string; file: File }[],
): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((ok, err) => (entry as FileEntry).file(ok, err));
    out.push({ path: prefix + entry.name, file });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as DirEntry).createReader();
  for (;;) {
    const batch = await new Promise<Entry[]>((ok, err) => reader.readEntries(ok, err));
    if (batch.length === 0) break;
    for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
  }
}

export async function collectFromDrop(dt: DataTransfer): Promise<Collected> {
  const entries: Entry[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue;
    const e = (
      item as DataTransferItem & { webkitGetAsEntry?: () => Entry | null }
    ).webkitGetAsEntry?.();
    if (e) entries.push(e);
  }
  if (entries.length === 0) return collectFromFiles(Array.from(dt.files ?? []));

  const found: { path: string; file: File }[] = [];
  for (const e of entries) await walk(e, '', found);
  const raw: UploadFile[] = [];
  const budget = { bytes: 0 };
  for (const f of found) await expand(f.path, f.file, raw, budget);
  return finish(raw, zipName(found.map((f) => f.file)));
}
