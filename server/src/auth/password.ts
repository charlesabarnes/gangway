/**
 * Password hashing: scrypt from `node:crypto` (§8.1, §13 -- no native addon).
 *
 * The stored hash is self-describing, `scrypt$ln=15,r=8,p=1$<base64 key>`, with the salt
 * in its own column. Cost can therefore be raised later without a migration: old rows
 * keep verifying at the cost they were made with, and `needsRehash` upgrades them at the
 * next successful login.
 *
 * scrypt is deliberately expensive, and this process is also a reverse proxy. Two rules
 * keep a login storm from becoming a proxy outage:
 *  - the ASYNC scrypt, which runs on the libuv threadpool, never the event loop;
 *  - a small semaphore. The pool has four threads and `dns.lookup` and `fs` share it, so
 *    at most two hashes run at once, a few more wait, and the rest are told to come back.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { rateLimited } from "../errors.ts";

export type PasswordOptions = {
  /** log2(N). 15 is ~32 MiB and tens of milliseconds. Tests use 10. */
  ln?: number;
  concurrency?: number;
  maxQueue?: number;
};

type Params = { ln: number; r: number; p: number };

const KEY_LEN = 64;
const SALT_LEN = 16;
const FORMAT = /^scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]+=*)$/;
/** A stored hash is data: refuse parameters that would turn verifying it into a denial of service. */
const LIMITS = { ln: [10, 20], r: [1, 16], p: [1, 4] } as const;

function derive(password: string, salt: Buffer, { ln, r, p }: Params): Promise<Buffer> {
  // Node's default maxmem is 32 MiB, which is EXACTLY what N=2^15,r=8 needs -- so the
  // default throws. Ask for what the parameters require, with headroom.
  const opts: ScryptOptions = { N: 2 ** ln, r, p, maxmem: 128 * 2 ** ln * r * 2 };
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, KEY_LEN, opts, (e, key) =>
      e ? reject(e) : resolve(key),
    ),
  );
}

function parse(stored: string): (Params & { key: Buffer }) | null {
  const m = FORMAT.exec(stored);
  if (!m) return null;
  const [ln, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const within = (v: number, [lo, hi]: readonly [number, number]) => v >= lo && v <= hi;
  if (!within(ln, LIMITS.ln) || !within(r, LIMITS.r) || !within(p, LIMITS.p)) return null;
  const key = Buffer.from(m[4]!, "base64");
  return key.length === KEY_LEN ? { ln, r, p, key } : null;
}

export class Passwords {
  readonly #params: Params;
  readonly #concurrency: number;
  readonly #maxQueue: number;
  #running = 0;
  readonly #waiting: (() => void)[] = [];
  #dummy: Promise<{ hash: string; salt: string }> | null = null;

  constructor(o: PasswordOptions = {}) {
    this.#params = { ln: o.ln ?? 15, r: 8, p: 1 };
    this.#concurrency = o.concurrency ?? 2;
    this.#maxQueue = o.maxQueue ?? 8;
  }

  async #slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.#running >= this.#concurrency) {
      if (this.#waiting.length >= this.#maxQueue)
        throw rateLimited(2, "the server is busy; try again shortly");
      await new Promise<void>((go) => this.#waiting.push(go));
    }
    this.#running++;
    try {
      return await work();
    } finally {
      this.#running--;
      this.#waiting.shift()?.();
    }
  }

  async hash(password: string): Promise<{ hash: string; salt: string }> {
    const salt = randomBytes(SALT_LEN);
    const { ln, r, p } = this.#params;
    const key = await this.#slot(() => derive(password, salt, this.#params));
    return {
      hash: `scrypt$ln=${ln},r=${r},p=${p}$${key.toString("base64")}`,
      salt: salt.toString("base64"),
    };
  }

  /** False for a wrong password AND for a stored value that does not parse: never throws on bad data. */
  async verify(password: string, stored: { hash: string; salt: string }): Promise<boolean> {
    const parsed = parse(stored.hash);
    if (!parsed) return false;
    const key = await this.#slot(() =>
      derive(password, Buffer.from(stored.salt, "base64"), parsed),
    );
    return timingSafeEqual(key, parsed.key);
  }

  /**
   * What login runs when the email is unknown, so "no such account" costs exactly what
   * "wrong password" costs. Without it, response time is a user-enumeration oracle.
   */
  async verifyDummy(password: string): Promise<false> {
    this.#dummy ??= this.hash(randomBytes(18).toString("base64"));
    await this.verify(password, await this.#dummy);
    return false;
  }

  needsRehash(storedHash: string): boolean {
    const parsed = parse(storedHash);
    return (
      !parsed ||
      parsed.ln !== this.#params.ln ||
      parsed.r !== this.#params.r ||
      parsed.p !== this.#params.p
    );
  }
}
