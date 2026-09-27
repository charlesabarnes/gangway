import { Bounded, sourceKey } from "../auth/limiter.ts";

/** Per minute; 0 turns that limit off. */
export type RateLimits = {
  perClient: number;
  perPreview: number;
  socketsPerClient: number;
};

type Bucket = { tokens: number; at: number };

/** Token buckets holding a minute's worth: a page's burst passes, a flood does not. */
export class RequestRates {
  readonly #limits: () => RateLimits;
  readonly #now: () => number;
  readonly #clients = new Bounded<Bucket>(100_000);
  readonly #previews = new Bounded<Bucket>(20_000);
  readonly #sockets = new Map<string, number>();
  readonly #report: ((refused: number) => void) | undefined;
  #refused = 0;
  #reportedAt = 0;

  constructor(
    limits: () => RateLimits,
    o: { now?: () => number; report?: (refused: number) => void } = {},
  ) {
    this.#limits = limits;
    this.#now = o.now ?? Date.now;
    this.#report = o.report;
  }

  /** null to go ahead; otherwise how many seconds until it would be let through. */
  take(clientIp: string, previewId: string): number | null {
    const l = this.#limits();
    const client = this.#check(this.#clients, sourceKey(clientIp), l.perClient);
    const preview = this.#check(this.#previews, previewId, l.perPreview);
    const wait = Math.max(client, preview);
    if (wait > 0) {
      this.#refuse();
      return Math.ceil(wait / 1000);
    }
    this.#spend(this.#clients, sourceKey(clientIp), l.perClient);
    this.#spend(this.#previews, previewId, l.perPreview);
    return null;
  }

  /** Counts a socket in, or refuses it; call the returned release when it closes. */
  openSocket(clientIp: string): (() => void) | null {
    const max = this.#limits().socketsPerClient;
    const key = sourceKey(clientIp);
    const open = this.#sockets.get(key) ?? 0;
    if (max > 0 && open >= max) {
      this.#refuse();
      return null;
    }
    this.#sockets.set(key, open + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.#sockets.get(key) ?? 1) - 1;
      if (left <= 0) this.#sockets.delete(key);
      else this.#sockets.set(key, left);
    };
  }

  #refuse(): void {
    this.#refused++;
    const now = this.#now();
    if (!this.#report || now - this.#reportedAt < 60_000) return;
    this.#report(this.#refused);
    this.#refused = 0;
    this.#reportedAt = now;
  }

  #check(buckets: Bounded<Bucket>, key: string, perMinute: number): number {
    if (perMinute <= 0) return 0;
    const b = this.#fill(buckets, key, perMinute);
    return b.tokens >= 1 ? 0 : ((1 - b.tokens) * 60_000) / perMinute;
  }

  #spend(buckets: Bounded<Bucket>, key: string, perMinute: number): void {
    if (perMinute <= 0) return;
    const b = this.#fill(buckets, key, perMinute);
    buckets.set(key, { tokens: b.tokens - 1, at: b.at });
  }

  #fill(buckets: Bounded<Bucket>, key: string, perMinute: number): Bucket {
    const now = this.#now();
    const b = buckets.get(key);
    if (!b) return { tokens: perMinute, at: now };
    const tokens = Math.min(perMinute, b.tokens + ((now - b.at) * perMinute) / 60_000);
    return { tokens, at: now };
  }
}
