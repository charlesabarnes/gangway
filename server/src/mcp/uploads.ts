/**
 * Upload by reference. `files` makes an agent retype every byte of its app into the tool
 * call, slowly, and the copy can drift from what it tested. Instead `deploy` with
 * `upload: "new"` hands out a one-use URL, the agent's shell sends a tar.gz there
 * (`tar | curl`), and `deploy` with `upload: "<id>"` builds exactly those bytes.
 *
 * The URL is a capability: 256 bits, one PUT, 15 minutes, no bearer (the agent's shell has
 * no token; its MCP client holds it). Whoever PUTs, only the credential that asked for the
 * slot can deploy from it -- a leaked URL lets someone hand you a tarball, which you then
 * decline to deploy, never deploy as you.
 *
 * Bytes wait on disk under `<state>/uploads/`, capped as they stream in, and are gone after
 * the deploy has unpacked them, when the slot expires, or at the next boot.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { actorId, type Actor } from "../auth/actor.ts";
import { AppError, conflict, notFound, unprocessable } from "../errors.ts";

export const UPLOAD_TTL_MS = 15 * 60_000;
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
const MAX_PER_OWNER = 10;
const MAX_PENDING = 100;
const ID = /^[A-Za-z0-9_-]{43}$/;

type Slot = {
  id: string;
  owner: string;
  expiresAt: number;
  state: "waiting" | "receiving" | "received" | "taken";
  bytes: number;
  sha256: string;
};

export type Issued = { id: string; url: string; expiresAt: number; maxBytes: number };
export type Taken = {
  archive: ReadableStream<Uint8Array>;
  digest: string;
  bytes: number;
  done: () => Promise<void>;
};

export class Uploads {
  readonly #dir: string;
  readonly #url: (id: string) => string;
  readonly #now: () => number;
  readonly #maxBytes: number;
  readonly #slots = new Map<string, Slot>();

  constructor(o: {
    dir: string;
    url: (id: string) => string;
    now?: () => number;
    maxBytes?: number;
  }) {
    this.#dir = o.dir;
    this.#url = o.url;
    this.#now = o.now ?? Date.now;
    this.#maxBytes = o.maxBytes ?? MAX_UPLOAD_BYTES;
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    // Slots live in memory: whatever a previous process left behind is nobody's now.
    for (const f of readdirSync(this.#dir))
      rmSync(join(this.#dir, f), { force: true, recursive: true });
  }

  #path(id: string): string {
    return join(this.#dir, `${id}.tar.gz`);
  }

  #sweep(): void {
    const now = this.#now();
    for (const s of this.#slots.values()) {
      if (s.expiresAt <= now && s.state !== "receiving" && s.state !== "taken") {
        this.#slots.delete(s.id);
        rmSync(this.#path(s.id), { force: true });
      }
    }
  }

  issue(actor: Actor): Issued {
    this.#sweep();
    const owner = actorId(actor);
    const mine = [...this.#slots.values()].filter(
      (s) => s.owner === owner && s.state !== "taken",
    ).length;
    if (mine >= MAX_PER_OWNER)
      throw new AppError(
        "rate_limited",
        `${MAX_PER_OWNER} uploads are already waiting for this credential; use or let them expire (${UPLOAD_TTL_MS / 60_000} min)`,
      );
    if (this.#slots.size >= MAX_PENDING)
      throw new AppError(
        "rate_limited",
        "too many uploads are waiting on this server; try again in a few minutes",
      );
    const id = randomBytes(32).toString("base64url");
    const slot: Slot = {
      id,
      owner,
      expiresAt: this.#now() + UPLOAD_TTL_MS,
      state: "waiting",
      bytes: 0,
      sha256: "",
    };
    this.#slots.set(id, slot);
    return { id, url: this.#url(id), expiresAt: slot.expiresAt, maxBytes: this.#maxBytes };
  }

  /** The PUT. Streams to disk, hashing and counting on the way; over the cap, it stops and forgets. */
  async receive(
    id: string,
    body: ReadableStream<Uint8Array> | null,
    declaredLength?: number,
  ): Promise<{ bytes: number; sha256: string }> {
    this.#sweep();
    const slot = ID.test(id) ? this.#slots.get(id) : undefined;
    if (!slot || slot.expiresAt <= this.#now())
      throw notFound('no such upload, or it expired; ask deploy for a new one with upload: "new"');
    if (slot.state !== "waiting")
      throw conflict("this upload URL was already used; ask deploy for a new one");
    if (!body) throw unprocessable("send the tar.gz as the request body");
    if (declaredLength !== undefined && declaredLength > this.#maxBytes)
      throw new AppError("payload_too_large", `at most ${this.#maxBytes} bytes`);
    slot.state = "receiving";
    const path = this.#path(id);
    const hash = createHash("sha256");
    let bytes = 0;
    const fh = await open(path, "wx", 0o600);
    try {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > this.#maxBytes)
          throw new AppError("payload_too_large", `at most ${this.#maxBytes} bytes`);
        hash.update(chunk);
        await fh.write(chunk);
      }
    } catch (e) {
      await fh.close();
      await rm(path, { force: true });
      slot.state = "waiting";
      throw e;
    }
    await fh.close();
    if (bytes === 0) {
      await rm(path, { force: true });
      slot.state = "waiting";
      throw unprocessable("the body was empty; send the tar.gz");
    }
    slot.state = "received";
    slot.bytes = bytes;
    slot.sha256 = hash.digest("hex");
    return { bytes, sha256: slot.sha256 };
  }

  /** For `deploy`: the bytes, once, and only to the credential that asked for the slot. */
  take(id: string, actor: Actor): Taken {
    this.#sweep();
    const slot = ID.test(id) ? this.#slots.get(id) : undefined;
    if (!slot || slot.owner !== actorId(actor))
      throw notFound(
        'no such upload for this credential, or it expired; ask for a new one with upload: "new"',
      );
    if (slot.state === "waiting" || slot.state === "receiving")
      throw conflict(
        `nothing has been sent to this upload yet; PUT the tar.gz to ${this.#url(id)} first`,
      );
    if (slot.state === "taken")
      throw conflict("this upload was already deployed; ask for a new one");
    slot.state = "taken";
    const path = this.#path(id);
    return {
      archive: Bun.file(path).stream(),
      digest: `sha256:${slot.sha256}`,
      bytes: slot.bytes,
      done: async () => {
        this.#slots.delete(id);
        await rm(path, { force: true });
      },
    };
  }

  get pending(): number {
    return this.#slots.size;
  }
}
