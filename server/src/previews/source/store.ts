import { cp, lstat, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { badRequest } from "../../errors.ts";
import { isUlid } from "../../util/ulid.ts";
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
    if (!isUlid(previewId)) throw badRequest("invalid preview id");
    return path.join(this.#root, previewId);
  }

  async has(previewId: string): Promise<boolean> {
    return (await lstat(this.dirFor(previewId)).catch(() => null))?.isDirectory() ?? false;
  }

  async adopt(previewId: string, dir: string): Promise<void> {
    const dest = this.dirFor(previewId);
    const old = `${dest}.old`;
    await mkdir(this.#root, { recursive: true, mode: MODE });
    await rm(old, { recursive: true, force: true });
    if (await this.has(previewId)) await rename(dest, old);
    await rename(dir, dest);
    await rm(old, { recursive: true, force: true });
  }

  async copyTo(previewId: string, toDir: string): Promise<void> {
    await cp(this.dirFor(previewId), toDir, {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: false,
    });
  }

  async remove(previewId: string): Promise<void> {
    const dir = this.dirFor(previewId);
    await Promise.all([dir, `${dir}.old`].map((d) => rm(d, { recursive: true, force: true })));
  }

  async ids(): Promise<string[]> {
    const entries = await readdir(this.#root, { withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isDirectory() && isUlid(e.name)).map((e) => e.name);
  }

  async list(previewId: string): Promise<SourceListing> {
    const root = this.dirFor(previewId);
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
        if (!e.isFile()) continue;
        const bytes = await readFile(abs);
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

export function asText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
