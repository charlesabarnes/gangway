/**
 * Scratch working directories, one per deploy (§5.1).
 *
 * Source ingestion needs somewhere to put a clone or an extracted tarball before the build
 * reads it. That somewhere lives under the state dir, not /tmp: it can hold a repo's worth
 * of bytes and the operator already sized the state volume. It is 0700 because a checkout
 * routinely contains the repository's own secrets.
 *
 * Nothing here is authoritative -- a workdir is safe to delete at any moment, and a crash
 * must not leave the next run wedged. Hence `create` wipes before it makes, and `cleanup`
 * is a no-op on a directory that is already gone.
 */
import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { badRequest } from "../../errors.ts";
import { containedIn } from "./types.ts";

/** Deploy ids are ULIDs, but this is the only thing between a caller and `rm -rf`. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 0700: a checkout is not world-readable, and neither is an uploaded tarball. */
const WORKDIR_MODE = 0o700;

export type Workdir = {
  id: string;
  /** The deploy's private root. Nothing outside `dir` is ever touched. */
  dir: string;
  /** Where the source itself lands, kept separate from any scratch a builder wants. */
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
    // Belt and braces behind SAFE_ID: no caller-supplied string ever escapes the root.
    if (!containedIn(this.#root, dir)) throw badRequest("invalid workdir id", { id: id.slice(0, 64) });
    return dir;
  }

  /** Idempotent: an existing directory from a crashed run is removed, not merged into. */
  async create(id: string): Promise<Workdir> {
    const dir = this.pathFor(id);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: WORKDIR_MODE });

    const srcDir = path.join(dir, "src");
    await mkdir(srcDir, { mode: WORKDIR_MODE });

    return { id, dir, srcDir, cleanup: () => this.remove(id) };
  }

  /** Removes the whole tree. Safe to call twice, and on an id that was never created. */
  async remove(id: string): Promise<void> {
    await rm(this.pathFor(id), { recursive: true, force: true });
  }

  /**
   * Runs `fn` against a fresh workdir and removes it afterwards, including when `fn`
   * throws -- a failed deploy is exactly the case where the bytes must not be left behind.
   */
  async with<T>(id: string, fn: (w: Workdir) => Promise<T>): Promise<T> {
    const workdir = await this.create(id);
    try {
      return await fn(workdir);
    } finally {
      await workdir.cleanup();
    }
  }

  /**
   * Startup sweep. The state dir survives restarts; scratch must not, or a box that
   * crashed mid-deploy leaks a checkout per restart.
   */
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

  /** Resolves the root through any symlinks, for callers that need to compare paths. */
  async realRoot(): Promise<string> {
    await mkdir(this.#root, { recursive: true, mode: WORKDIR_MODE });
    return await realpath(this.#root);
  }
}
