/**
 * The kept source of an uploaded preview (ADR-0015): what the user sent, so it can be read
 * back into the editor and rebuilt at the same URL.
 *
 * `state/sources/<previewId>/`, 0700. Written from a deploy's source directory AFTER the
 * symlink guard and BEFORE gangway adds `.env` or `.gangway/`, so it never holds a secret
 * gangway put there. A replacement is swapped in with renames: a crash leaves the old tree
 * or the new one (possibly as `<id>.old`), never half of each.
 */
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { badRequest } from "../../errors.ts";
import { isUlid } from "../../util/ulid.ts";

const MODE = 0o700;
/** Larger files are listed, not inlined: the editor is for source, not assets. */
export const MAX_INLINE_BYTES = 512 * 1024;
/** Past this many entries the listing stops and says so. */
export const MAX_LISTED = 2_000;
/** The directory gangway writes its generated build files to; never kept, never editable. */
export const GENERATED_DIR = ".gangway";

export type SourceFile = { path: string; size: number; text?: string };
export type SourceListing = { files: SourceFile[]; truncated: boolean };

export class SourceStore {
  readonly #root: string;

  constructor(stateDir: string) {
    this.#root = path.resolve(stateDir, "sources");
  }

  dirFor(previewId: string): string {
    // The id names a directory that gets `rm -rf`'d: nothing but a ULID gets near it.
    if (!isUlid(previewId)) throw badRequest("invalid preview id");
    return path.join(this.#root, previewId);
  }

  async has(previewId: string): Promise<boolean> {
    return (await lstat(this.dirFor(previewId)).catch(() => null))?.isDirectory() ?? false;
  }

  /**
   * Moves `dir` in as the preview's source, replacing any it had. `dir` must be on the same
   * filesystem (a workdir under the same state dir) and must not hold `.gangway/`.
   */
  async adopt(previewId: string, dir: string): Promise<void> {
    const dest = this.dirFor(previewId);
    const old = `${dest}.old`;
    await mkdir(this.#root, { recursive: true, mode: MODE });
    await rm(old, { recursive: true, force: true });
    if (await this.has(previewId)) await rename(dest, old);
    await rename(dir, dest);
    await rm(old, { recursive: true, force: true });
  }

  /** Copies the kept source into `toDir` (which must exist), for a rebuild to work on. */
  async copyTo(previewId: string, toDir: string): Promise<void> {
    await cp(this.dirFor(previewId), toDir, { recursive: true, verbatimSymlinks: true, errorOnExist: false });
  }

  async remove(previewId: string): Promise<void> {
    const dir = this.dirFor(previewId);
    await Promise.all([dir, `${dir}.old`].map((d) => rm(d, { recursive: true, force: true })));
  }

  /** Every preview id with a kept source, for the boot-time sweep. */
  async ids(): Promise<string[]> {
    const entries = await readdir(this.#root, { withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isDirectory() && isUlid(e.name)).map((e) => e.name);
  }

  /** Regular files, sorted, text inlined where it is small and really text. Symlinks are skipped. */
  async list(previewId: string): Promise<SourceListing> {
    const root = this.dirFor(previewId);
    const files: SourceFile[] = [];
    let truncated = false;
    const walk = async (dir: string): Promise<void> => {
      const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (files.length >= MAX_LISTED) { truncated = true; return; }
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { await walk(abs); continue; }
        if (!e.isFile()) continue;
        const rel = path.relative(root, abs).split(path.sep).join("/");
        const size = (await lstat(abs)).size;
        const file: SourceFile = { path: rel, size };
        if (size <= MAX_INLINE_BYTES) {
          const text = asText(await readFile(abs));
          if (text !== null) file.text = text;
        }
        files.push(file);
      }
    };
    await walk(root);
    return { files, truncated };
  }

  /**
   * ADR-0021: what is really deployed, file by file -- sha256 over the bytes gangway kept, so
   * a caller can check them against what it meant to send (`shasum -a 256`). Sorted like `list`.
   */
  async manifest(previewId: string): Promise<{ files: { path: string; bytes: number; sha256: string }[]; truncated: boolean }> {
    const root = this.dirFor(previewId);
    const out: { path: string; bytes: number; sha256: string }[] = [];
    let truncated = false;
    const walk = async (dir: string): Promise<void> => {
      const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (out.length >= MAX_LISTED) { truncated = true; return; }
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { await walk(abs); continue; }
        if (!e.isFile()) continue;
        const bytes = await readFile(abs);
        out.push({ path: path.relative(root, abs).split(path.sep).join("/"), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    };
    await walk(root);
    return { files: out, truncated };
  }
}

/** UTF-8 with no NUL bytes, or null: what the editor may show and write back unchanged. */
export function asText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
