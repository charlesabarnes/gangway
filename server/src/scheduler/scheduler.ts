/**
 * Named periodic jobs for the one process: reconcile, the TTL sweep, the lastSeen flush,
 * and later certificate renewal and idle-sleep.
 *
 * What it guarantees, each of which a bare `setInterval` does not:
 *
 *  1. A JOB NEVER OVERLAPS ITSELF. The next run is scheduled when the previous one
 *     SETTLES, so a pass that outlives its interval delays the next instead of stacking
 *     on it. `trigger()` joins a run in flight rather than starting a second.
 *  2. JITTER. Every delay is spread by +/- `jitter`, so jobs sharing an interval do not
 *     fire in the same tick forever, and two instances on one daemon do not scan in step.
 *  3. A THROWING JOB IS A LOG LINE, not an unhandled rejection and not the end of the job.
 *  4. STOP IS GRACEFUL. No new runs, running jobs are told through their AbortSignal and
 *     WAITED for up to a deadline -- so the database is never closed under a job's feet.
 *
 * Timers are unref'd: the scheduler never keeps the process alive on its own.
 */
import type { Logger } from "../logger.ts";

export type Job = {
  name: string;
  /** Time from the END of one run to the start of the next. <= 0 registers the job disabled. */
  intervalMs: number;
  /** Fraction of the interval, 0..1. Default 0.1: a 60s job runs every 54-66s. */
  jitter?: number;
  /** Delay before the first run. Default: one (jittered) interval. */
  initialDelayMs?: number;
  /** May return a promise; the scheduler awaits it. */
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
  /** Tests drive time by hand through this. */
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

  /** Registering after `start()` schedules the job at once; after `stop()` it is an error. */
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

  /**
   * Runs a job now, outside its schedule -- or joins the run already in flight. Works
   * for disabled jobs too: "interval 0" means "not periodically", not "never".
   * Rejects if the job does; the periodic path logs instead.
   */
  trigger(name: string): Promise<void> {
    const e = this.#jobs.get(name);
    if (!e) return Promise.reject(new Error(`no such job: ${name}`));
    if (this.#stopping) return Promise.reject(new Error("scheduler is stopped"));
    return this.#run(e);
  }

  status(): JobStatus[] {
    return [...this.#jobs.values()].map((e) => ({ ...e.status }));
  }

  /**
   * Idempotent. Resolves when every running job has settled, or after `timeoutMs` --
   * whichever is first; jobs still running at the deadline are named in a warning.
   */
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
      // Re-armed from the END of the run, whoever started it: that is rule 1.
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
        // Yield first, so `current` is assigned before a synchronous job can finish:
        // otherwise the `finally` below clears it and the assignment then resurrects it.
        await Promise.resolve();
        await e.job.run(this.#abort.signal);
        s.lastError = null;
      } catch (err) {
        s.failures++;
        s.lastError = err instanceof Error ? err.message : String(err);
        // An abort during stop() is the job doing what it was told.
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
