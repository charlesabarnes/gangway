import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { badRequest } from "../../errors.ts";
import { containedIn } from "./types.ts";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const WORKDIR_MODE = 0o700;

export type Workdir = {
  id: string;
  dir: string;
  srcDir: string;
  cleanup: () => Promise<void>;
};

export class Workdirs {
  readonly #root: string;

  constructor(stateDir: string) {
    this.#root = path.resolve(stateDir, "work");
  }

  get root(): string {
    return this.#root;
  }

  pathFor(id: string): string {
    if (!SAFE_ID.test(id)) throw badRequest("invalid workdir id", { id: id.slice(0, 64) });
    const dir = path.join(this.#root, id);
    if (!containedIn(this.#root, dir))
      throw badRequest("invalid workdir id", { id: id.slice(0, 64) });
    return dir;
  }

  async create(id: string): Promise<Workdir> {
    const dir = this.pathFor(id);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: WORKDIR_MODE });

    const srcDir = path.join(dir, "src");
    await mkdir(srcDir, { mode: WORKDIR_MODE });

    return { id, dir, srcDir, cleanup: () => this.remove(id) };
  }

  async remove(id: string): Promise<void> {
    await rm(this.pathFor(id), { recursive: true, force: true });
  }

  async with<T>(id: string, fn: (w: Workdir) => Promise<T>): Promise<T> {
    const workdir = await this.create(id);
    try {
      return await fn(workdir);
    } finally {
      await workdir.cleanup();
    }
  }

  async prune(): Promise<string[]> {
    const entries = await readdir(this.#root, { withFileTypes: true }).catch(() => []);
    const removed: string[] = [];
    for (const entry of entries) {
      if (!SAFE_ID.test(entry.name)) continue;
      await this.remove(entry.name);
      removed.push(entry.name);
    }
    return removed;
  }

  async realRoot(): Promise<string> {
    await mkdir(this.#root, { recursive: true, mode: WORKDIR_MODE });
    return await realpath(this.#root);
  }
}
