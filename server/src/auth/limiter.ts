/**
 * Login throttling (§8.1: "Rate-limit login. Lock after repeated failures"). Two
 * independent counters, because there are two independent attacks:
 *  - per SOURCE: one address spraying many accounts. 10 failures in 15 minutes.
 *  - per ACCOUNT: many addresses guessing one password. 5 free failures, then a lock that
 *    doubles -- 1, 2, 4, 8 minutes -- capped at 15.
 *
 * Checked BEFORE scrypt runs, so a locked-out attacker costs a Map lookup, not 32 MiB.
 *
 * In memory, on purpose. A persisted lock is a durable denial of service against the only
 * admin, written by whoever wants to write it; a restart clearing these counters is an
 * acceptable price for one process. The env admin token is break-glass either way.
 *
 * The per-account lock DOES let a stranger delay a known admin's UI login by up to 15
 * minutes a cycle. That is the trade every lockout makes; the alternative is unlimited
 * guessing against that same admin.
 */
export type LimiterOptions = {
  ipMax?: number;
  ipWindowMs?: number;
  emailFree?: number;
  emailBaseLockMs?: number;
  emailMaxLockMs?: number;
  /** A failure streak is forgotten after this long without another failure. */
  forgetAfterMs?: number;
  maxKeys?: number;
};

export type LimiterVerdict =
  { ok: true } | { ok: false; retryAfterSec: number; reason: "ip" | "email" };

type EmailState = { failures: number; lockedUntil: number; lastFailure: number };

const MIN = 60_000;

/**
 * One IPv6 customer is a /64, not an address: keying on the full address hands an
 * attacker 2^64 fresh counters. IPv4 is keyed whole. The input is already trusted-proxy
 * resolved and `::ffff:`-unmapped (net/trusted-proxy.ts).
 */
export function sourceKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("%")[0]!.split("::");
  const h = head === "" ? [] : head.split(":");
  const t = tail === "" ? [] : tail.split(":");
  const groups = ip.includes("::")
    ? [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t]
    : h;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/** Insertion-ordered Map as an LRU: a flood of fresh keys evicts the oldest, not the process. */
class Bounded<V> {
  readonly #max: number;
  readonly #map = new Map<string, V>();
  constructor(max: number) {
    this.#max = max;
  }
  get(k: string): V | undefined {
    return this.#map.get(k);
  }
  set(k: string, v: V): void {
    this.#map.delete(k);
    this.#map.set(k, v);
    if (this.#map.size > this.#max) this.#map.delete(this.#map.keys().next().value!);
  }
  delete(k: string): void {
    this.#map.delete(k);
  }
  get size(): number {
    return this.#map.size;
  }
}

export class LoginLimiter {
  readonly #o: Required<LimiterOptions>;
  readonly #now: () => number;
  readonly #ips: Bounded<number[]>;
  readonly #emails: Bounded<EmailState>;

  constructor(o: LimiterOptions = {}, now: () => number = Date.now) {
    this.#o = {
      ipMax: o.ipMax ?? 10,
      ipWindowMs: o.ipWindowMs ?? 15 * MIN,
      emailFree: o.emailFree ?? 5,
      emailBaseLockMs: o.emailBaseLockMs ?? MIN,
      emailMaxLockMs: o.emailMaxLockMs ?? 15 * MIN,
      forgetAfterMs: o.forgetAfterMs ?? 60 * MIN,
      maxKeys: o.maxKeys ?? 10_000,
    };
    this.#now = now;
    // Separate bounds: spraying 10,000 addresses must not evict one account's lock.
    this.#ips = new Bounded(this.#o.maxKeys);
    this.#emails = new Bounded(this.#o.maxKeys);
  }

  #recent(ip: string, now: number): number[] {
    return (this.#ips.get(sourceKey(ip)) ?? []).filter((t) => t > now - this.#o.ipWindowMs);
  }

  check(ip: string, email: string): LimiterVerdict {
    const now = this.#now();
    const sec = (until: number) => Math.max(1, Math.ceil((until - now) / 1000));

    const e = this.#emails.get(email);
    if (e && e.lockedUntil > now)
      return { ok: false, retryAfterSec: sec(e.lockedUntil), reason: "email" };

    const recent = this.#recent(ip, now);
    if (recent.length >= this.#o.ipMax)
      return { ok: false, retryAfterSec: sec(recent[0]! + this.#o.ipWindowMs), reason: "ip" };
    return { ok: true };
  }

  fail(ip: string, email: string): void {
    const now = this.#now();
    this.#ips.set(sourceKey(ip), [...this.#recent(ip, now), now].slice(-this.#o.ipMax));

    const prev = this.#emails.get(email);
    const failures =
      (prev && prev.lastFailure > now - this.#o.forgetAfterMs ? prev.failures : 0) + 1;
    const over = failures - this.#o.emailFree;
    const lock =
      over < 0 ? 0 : Math.min(this.#o.emailMaxLockMs, this.#o.emailBaseLockMs * 2 ** over);
    this.#emails.set(email, { failures, lockedUntil: now + lock, lastFailure: now });
  }

  /**
   * Clears the ACCOUNT's streak only. Clearing the source's too would let anyone with one
   * valid login reset their own counter between guesses at someone else's.
   */
  succeed(email: string): void {
    this.#emails.delete(email);
  }

  get trackedKeys(): { ips: number; emails: number } {
    return { ips: this.#ips.size, emails: this.#emails.size };
  }
}
