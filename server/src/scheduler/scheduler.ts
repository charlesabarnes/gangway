import type { Logger } from "../logger.ts";
import { errorMessage } from "../errors.ts";

export type Job = {
  name: string;
  intervalMs: number;
  jitter?: number;
  initialDelayMs?: number;
  run(signal: AbortSignal): unknown;
};

export type JobStatus = {
  name: string;
  enabled: boolean;
  running: boolean;
  runs: number;
  failures: number;
  lastStartedAt: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
};

type TimerHandle = { cancel(): void };

export type SchedulerOptions = {
  logger: Logger;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
};

type Entry = {
  job: Job;
  status: JobStatus;
  timer: TimerHandle | null;
  current: Promise<void> | null;
};

const realTimer = (fn: () => void, ms: number): TimerHandle => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { cancel: () => clearTimeout(t) };
};

export function jittered(intervalMs: number, jitter: number, random: () => number): number {
  const j = Math.min(1, Math.max(0, jitter));
  return Math.max(0, Math.round(intervalMs * (1 + j * (random() * 2 - 1))));
}

export class Scheduler {
  readonly #o: SchedulerOptions;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #setTimer: (fn: () => void, ms: number) => TimerHandle;
  readonly #jobs = new Map<string, Entry>();
  readonly #abort = new AbortController();
  #started = false;
  #stopping: Promise<void> | null = null;

  constructor(o: SchedulerOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
    this.#random = o.random ?? Math.random;
    this.#setTimer = o.setTimer ?? realTimer;
  }

  register(job: Job): void {
    if (this.#stopping) throw new Error(`scheduler is stopped; cannot register ${job.name}`);
    if (this.#jobs.has(job.name)) throw new Error(`duplicate job name: ${job.name}`);
    const entry: Entry = {
      job,
      timer: null,
      current: null,
      status: {
        name: job.name,
        enabled: job.intervalMs > 0,
        running: false,
        runs: 0,
        failures: 0,
        lastStartedAt: null,
        lastDurationMs: null,
        lastError: null,
      },
    };
    this.#jobs.set(job.name, entry);
    if (this.#started) this.#arm(entry, true);
  }

  start(): void {
    if (this.#started || this.#stopping) return;
    this.#started = true;
    for (const e of this.#jobs.values()) this.#arm(e, true);
  }

  trigger(name: string): Promise<void> {
    const e = this.#jobs.get(name);
    if (!e) return Promise.reject(new Error(`no such job: ${name}`));
    if (this.#stopping) return Promise.reject(new Error("scheduler is stopped"));
    return this.#run(e);
  }

  status(): JobStatus[] {
    return [...this.#jobs.values()].map((e) => ({ ...e.status }));
  }

  stop(timeoutMs = 10_000): Promise<void> {
    if (this.#stopping) return this.#stopping;
    for (const e of this.#jobs.values()) {
      e.timer?.cancel();
      e.timer = null;
    }
    this.#abort.abort();
    const running = [...this.#jobs.values()].filter((e) => e.current !== null);
    const settled = Promise.allSettled(running.map((e) => e.current).filter((p) => p !== null));
    const deadline: { timer: TimerHandle | null } = { timer: null };
    this.#stopping = Promise.race([
      settled.then(() => {}),
      new Promise<void>((resolve) => {
        deadline.timer = this.#setTimer(() => {
          const late = running.filter((e) => e.current !== null).map((e) => e.job.name);
          if (late.length)
            this.#o.logger.warn("scheduler stopped with jobs still running", {
              jobs: late,
              timeoutMs,
            });
          resolve();
        }, timeoutMs);
      }),
    ]).finally(() => deadline.timer?.cancel());
    return this.#stopping;
  }

  #arm(e: Entry, first: boolean): void {
    if (this.#stopping || e.job.intervalMs <= 0 || e.timer) return;
    const delay =
      first && e.job.initialDelayMs !== undefined
        ? Math.max(0, e.job.initialDelayMs)
        : jittered(e.job.intervalMs, e.job.jitter ?? 0.1, this.#random);
    e.timer = this.#setTimer(() => {
      e.timer = null;
      this.#run(e)
        .catch(() => {})
        .finally(() => this.#arm(e, false));
    }, delay);
  }

  #run(e: Entry): Promise<void> {
    if (e.current) return e.current;
    const s = e.status;
    const started = this.#now();
    s.running = true;
    s.lastStartedAt = started;
    e.current = (async () => {
      try {
        // Yield first, so current is assigned before a synchronous job can finish and clear it.
        await Promise.resolve();
        await e.job.run(this.#abort.signal);
        s.lastError = null;
      } catch (err) {
        s.failures++;
        s.lastError = errorMessage(err);
        if (!this.#abort.signal.aborted)
          this.#o.logger.error("scheduled job failed", { job: e.job.name, err });
        throw err;
      } finally {
        s.runs++;
        s.running = false;
        s.lastDurationMs = this.#now() - started;
        e.current = null;
      }
    })();
    return e.current;
  }
}
