import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { rateLimited } from "../errors.ts";

export type PasswordOptions = {
  ln?: number;
  concurrency?: number;
  maxQueue?: number;
};

type Params = { ln: number; r: number; p: number };

const KEY_LEN = 64;
const SALT_LEN = 16;
const FORMAT = /^scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]+=*)$/;
const LIMITS = { ln: [10, 20], r: [1, 16], p: [1, 4] } as const;

function derive(password: string, salt: Buffer, { ln, r, p }: Params): Promise<Buffer> {
  // Node's default maxmem of 32 MiB is exactly what N=2^15,r=8 needs, so the default throws.
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

  async verify(password: string, stored: { hash: string; salt: string }): Promise<boolean> {
    const parsed = parse(stored.hash);
    if (!parsed) return false;
    const key = await this.#slot(() =>
      derive(password, Buffer.from(stored.salt, "base64"), parsed),
    );
    return timingSafeEqual(key, parsed.key);
  }

  // Run for unknown emails so response time does not reveal which accounts exist.
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
