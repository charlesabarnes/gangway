export class SingleFlight<T> {
  #inflight = new Map<string, Promise<T>>();

  run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.#inflight.get(key);
    if (existing) return existing;
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
      if (o.shouldRetry && !o.shouldRetry(err)) throw err;
      if (i === attempts - 1) break;
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
    if (idle()) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
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
    if (v !== null && v !== undefined) return v;
    if (Date.now() + interval >= deadline) return null;
    await sleep(interval);
  }
}
