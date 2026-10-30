export class SingleFlight<T> {
  readonly #inflight = new Map<string, Promise<T>>();

  run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.#inflight.get(key);
    if (existing) {
      return existing;
    }
    const p = (async () => fn())().finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, p);
    return p;
  }

  get size() {
    return this.#inflight.size;
  }
  has(key: string) {
    return this.#inflight.has(key);
  }
}

/** At most `limit()` holders at once, the rest served fairly by key; a limit of 0 is none. */
/** The line in front of a Slots was already as long as it may be. */
export class LineFull extends Error {
  readonly waiting: number;

  constructor(waiting: number) {
    super(`${waiting} are already waiting`);
    this.waiting = waiting;
  }
}

export class Slots {
  readonly #limit: () => number;
  readonly #maxWaiting: () => number;
  #busy = 0;
  readonly #held = new Map<string, number>();
  #waiting: { key: string; turn: () => void }[] = [];

  /** `maxWaiting` caps the line; past it acquire throws LineFull. 0 for either is no limit. */
  constructor(limit: () => number, maxWaiting: () => number = () => 0) {
    this.#limit = limit;
    this.#maxWaiting = maxWaiting;
  }

  get waiting() {
    return this.#waiting.length;
  }

  /** After the limit changes: a raised one lets those waiting in now. */
  refresh() {
    this.#next();
  }

  /** Resolves to the release once a slot is free; a freed slot goes to the key holding fewest. */
  async acquire(signal?: AbortSignal, onWait?: () => void, key = ""): Promise<() => void> {
    signal?.throwIfAborted();
    // A raised limit goes to those already waiting before any newcomer.
    this.#next();
    if (this.#full()) {
      const max = this.#maxWaiting();
      if (max > 0 && this.#waiting.length >= max) {
        throw new LineFull(this.#waiting.length);
      }
      onWait?.();
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          this.#waiting = this.#waiting.filter((w) => w.turn !== turn);
          reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
        };
        const turn = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        this.#waiting.push({ key, turn });
        signal?.addEventListener("abort", abort, { once: true });
      });
    } else {
      this.#take(key);
    }
    let held = true;
    return () => {
      if (held) {
        held = false;
        this.#busy--;
        const left = (this.#held.get(key) ?? 1) - 1;
        if (left > 0) {
          this.#held.set(key, left);
        } else {
          this.#held.delete(key);
        }
        this.#next();
      }
    };
  }

  #full() {
    const n = this.#limit();
    return n > 0 && this.#busy >= n;
  }

  // A slot passes straight to the next in line, so a newcomer never overtakes it.
  #next() {
    while (this.#waiting.length > 0 && !this.#full()) {
      const held = (w: { key: string }) => this.#held.get(w.key) ?? 0;
      const first = this.#waiting.reduce((a, w) => (held(w) < held(a) ? w : a));
      this.#waiting = this.#waiting.filter((w) => w !== first);
      this.#take(first.key);
      first.turn();
    }
  }

  #take(key: string) {
    this.#busy++;
    this.#held.set(key, (this.#held.get(key) ?? 0) + 1);
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type BackoffOptions = {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  random?: () => number;
  signal?: AbortSignal;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  shouldRetry?: (err: unknown) => boolean;
};

export function backoffDelay(attempt: number, o: BackoffOptions = {}): number {
  const base = o.baseMs ?? 200;
  const max = o.maxMs ?? 30_000;
  const rand = o.random ?? Math.random;
  return Math.floor(rand() * Math.min(max, base * 2 ** attempt));
}

export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  o: BackoffOptions = {},
): Promise<T> {
  const attempts = o.attempts ?? 5;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    o.signal?.throwIfAborted();
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (o.shouldRetry && !o.shouldRetry(err)) {
        throw err;
      }
      if (i === attempts - 1) {
        break;
      }
      const delay = backoffDelay(i, o);
      o.onRetry?.(i, delay, err);
      await sleep(delay);
    }
  }
  throw lastErr;
}

export async function drain(
  idle: () => boolean,
  o: { timeoutMs: number; intervalMs?: number },
): Promise<boolean> {
  const deadline = Date.now() + o.timeoutMs;
  for (;;) {
    if (idle()) {
      return true;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      return false;
    }
    await sleep(Math.min(o.intervalMs ?? 50, left));
  }
}

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  o: { timeoutMs: number; intervalMs?: number; signal?: AbortSignal },
): Promise<T | null> {
  const deadline = Date.now() + o.timeoutMs;
  const interval = o.intervalMs ?? 500;
  for (;;) {
    o.signal?.throwIfAborted();
    const v = await fn();
    if (v !== null && v !== undefined) {
      return v;
    }
    if (Date.now() + interval >= deadline) {
      return null;
    }
    await sleep(interval);
  }
}
