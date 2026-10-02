import { cp, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { badRequest } from "../../errors.ts";
import { isUlid } from "../../util/ulid.ts";
import { readRegularFile } from "../../util/fs.ts";
import { sha256 } from "../../util/hash.ts";

const MODE = 0o700;
const MAX_INLINE_BYTES = 512 * 1024;
const MAX_LISTED = 2_000;
export const GENERATED_DIR = ".gangway";

export type SourceFile = { path: string; size: number; text?: string };
export type SourceListing = { files: SourceFile[]; truncated: boolean };

export class SourceStore {
  readonly #root: string;

  constructor(stateDir: string) {
    this.#root = path.resolve(stateDir, "sources");
  }

  dirFor(previewId: string): string {
    if (!isUlid(previewId)) {
      throw badRequest("invalid preview id");
    }
    return path.join(this.#root, previewId);
  }

  /** Edits a rebuild failed on, kept for the editor apart from the source that is serving. */
  draftDirFor(previewId: string): string {
    return `${this.dirFor(previewId)}.draft`;
  }

  async has(previewId: string): Promise<boolean> {
    return isDir(this.dirFor(previewId));
  }

  async hasDraft(previewId: string): Promise<boolean> {
    return isDir(this.draftDirFor(previewId));
  }

  /** What the editor shows and the next edit starts from: the draft when there is one. */
  async editableDir(previewId: string): Promise<string> {
    return (await this.hasDraft(previewId)) ? this.draftDirFor(previewId) : this.dirFor(previewId);
  }

  /** Store `dir` as the source of the version that is serving; any draft is done with. */
  async adopt(previewId: string, dir: string): Promise<void> {
    await rm(this.draftDirFor(previewId), { recursive: true, force: true });
    await this.#replace(this.dirFor(previewId), dir);
  }

  /** Keep `dir` as edits that did not deploy; the deployed source stays as it is. */
  async keepDraft(previewId: string, dir: string): Promise<void> {
    await this.#replace(this.draftDirFor(previewId), dir);
  }

  /** Either `dir` is at `dest`, or what was at `dest` is back there and this throws. */
  async #replace(dest: string, dir: string): Promise<void> {
    const old = `${dest}.old`;
    await mkdir(this.#root, { recursive: true, mode: MODE });
    await rm(old, { recursive: true, force: true });
    const had = await isDir(dest);
    if (had) {
      await rename(dest, old);
    }
    try {
      await rename(dir, dest);
    } catch (e) {
      if (had) {
        await rename(old, dest);
      }
      throw e;
    }
    await rm(old, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Copy the editable source, or with `deployed` the one that is serving. */
  async copyTo(previewId: string, toDir: string, { deployed = false } = {}): Promise<void> {
    const from = deployed ? this.dirFor(previewId) : await this.editableDir(previewId);
    await cp(from, toDir, {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: false,
    });
  }

  async remove(previewId: string): Promise<void> {
    const dir = this.dirFor(previewId);
    const draft = this.draftDirFor(previewId);
    await Promise.all(
      [dir, `${dir}.old`, draft, `${draft}.old`].map((d) =>
        rm(d, { recursive: true, force: true }),
      ),
    );
  }

  async ids(): Promise<string[]> {
    const entries = await readdir(this.#root, { withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isDirectory() && isUlid(e.name)).map((e) => e.name);
  }

  async list(previewId: string): Promise<SourceListing> {
    const root = await this.editableDir(previewId);
    const files: SourceFile[] = [];
    let truncated = false;
    const walk = async (dir: string): Promise<void> => {
      const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const e of entries) {
        if (files.length >= MAX_LISTED) {
          truncated = true;
          return;
        }
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(abs);
          continue;
        }
        if (!e.isFile()) {
          continue;
        }
        const rel = path.relative(root, abs).split(path.sep).join("/");
        const read = await readRegularFile(abs, MAX_INLINE_BYTES);
        if (!read) {
          continue;
        }
        const file: SourceFile = { path: rel, size: read.size };
        const text = read.data && asText(read.data);
        if (text !== null) {
          file.text = text;
        }
        files.push(file);
      }
    };
    await walk(root);
    return { files, truncated };
  }

  async manifest(
    previewId: string,
  ): Promise<{ files: { path: string; bytes: number; sha256: string }[]; truncated: boolean }> {
    const root = this.dirFor(previewId);
    const out: { path: string; bytes: number; sha256: string }[] = [];
    let truncated = false;
    const walk = async (dir: string): Promise<void> => {
      const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const e of entries) {
        if (out.length >= MAX_LISTED) {
          truncated = true;
          return;
        }
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(abs);
          continue;
        }
        if (!e.isFile()) {
          continue;
        }
        const bytes = (await readRegularFile(abs))?.data;
        if (!bytes) {
          continue;
        }
        out.push({
          path: path.relative(root, abs).split(path.sep).join("/"),
          bytes: bytes.length,
          sha256: sha256(bytes, "hex"),
        });
      }
    };
    await walk(root);
    return { files: out, truncated };
  }
}

async function isDir(p: string): Promise<boolean> {
  return (await lstat(p).catch(() => null))?.isDirectory() ?? false;
}

export function asText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
