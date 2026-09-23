import { describe, expect, test } from "bun:test";
import { Logger } from "../../src/logger.ts";
import { jittered, Scheduler } from "../../src/scheduler/scheduler.ts";
import { silentLogger } from "../helpers/logger.ts";

/** Time by hand: timers fire only when the test says so. */
function harness(random = () => 0.5) {
  let seq = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const lines: string[] = [];
  const scheduler = new Scheduler({
    logger: new Logger("info", {}, (l) => lines.push(l)),
    random,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { fn, ms });
      return { cancel: () => timers.delete(id) };
    },
  });
  /** Fires every timer currently armed with this delay; returns how many. */
  const fire = (ms: number) => {
    const due = [...timers].filter(([, t]) => t.ms === ms);
    for (const [id, t] of due) {
      timers.delete(id);
      t.fn();
    }
    return due.length;
  };
  const delays = () => [...timers.values()].map((t) => t.ms).sort((a, b) => a - b);
  return { scheduler, timers, fire, delays, lines };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("jittered", () => {
  test("spreads symmetrically around the interval and never goes negative", () => {
    expect(jittered(1000, 0.1, () => 0)).toBe(900);
    expect(jittered(1000, 0.1, () => 0.5)).toBe(1000);
    expect(jittered(1000, 0.1, () => 1)).toBe(1100);
    expect(jittered(1000, 0, () => 0)).toBe(1000);
    expect(jittered(1000, 5, () => 0)).toBe(0); // clamped to 1
  });
});

describe("Scheduler", () => {
  test("nothing is armed before start(); start arms each enabled job with a jittered delay", () => {
    const h = harness(() => 1);
    h.scheduler.register({ name: "a", intervalMs: 1000, run: () => {} });
    h.scheduler.register({ name: "b", intervalMs: 1000, jitter: 0.5, run: () => {} });
    h.scheduler.register({ name: "off", intervalMs: 0, run: () => {} });
    expect(h.delays()).toEqual([]);
    h.scheduler.start();
    h.scheduler.start(); // idempotent
    expect(h.delays()).toEqual([1100, 1500]);
    expect(h.scheduler.status().find((s) => s.name === "off")!.enabled).toBe(false);
  });

  test("initialDelayMs applies to the first run only", async () => {
    const h = harness();
    let runs = 0;
    h.scheduler.register({
      name: "a",
      intervalMs: 1000,
      initialDelayMs: 0,
      run: () => {
        runs++;
      },
    });
    h.scheduler.start();
    expect(h.delays()).toEqual([0]);
    h.fire(0);
    await tick();
    expect(runs).toBe(1);
    expect(h.delays()).toEqual([1000]);
  });

  test("the next run is armed only when the previous one settles -- a slow job never overlaps itself", async () => {
    const h = harness();
    const gate = deferred();
    let concurrent = 0,
      peak = 0;
    h.scheduler.register({
      name: "slow",
      intervalMs: 1000,
      run: async () => {
        peak = Math.max(peak, ++concurrent);
        await gate.promise;
        concurrent--;
      },
    });
    h.scheduler.start();
    h.fire(1000);
    await tick();
    expect(h.delays()).toEqual([]); // running: nothing armed
    expect(h.scheduler.status()[0]!.running).toBe(true);
    gate.resolve();
    await tick();
    expect(h.delays()).toEqual([1000]);
    expect(peak).toBe(1);
  });

  test("trigger joins a run in flight, and works on a disabled job", async () => {
    const h = harness();
    const gate = deferred();
    let runs = 0;
    h.scheduler.register({
      name: "off",
      intervalMs: 0,
      run: async () => {
        runs++;
        await gate.promise;
      },
    });
    h.scheduler.start();
    const a = h.scheduler.trigger("off");
    const b = h.scheduler.trigger("off");
    expect(a).toBe(b);
    gate.resolve();
    await a;
    expect(runs).toBe(1);
    await h.scheduler.trigger("off");
    expect(runs).toBe(2);
    expect(h.delays()).toEqual([]); // a manual run does not arm a disabled job
    await expect(h.scheduler.trigger("nope")).rejects.toThrow("no such job");
  });

  test("a synchronous job leaves no stale in-flight promise behind", async () => {
    const h = harness();
    let runs = 0;
    h.scheduler.register({
      name: "sync",
      intervalMs: 0,
      run: () => {
        runs++;
      },
    });
    await h.scheduler.trigger("sync");
    await h.scheduler.trigger("sync");
    expect(runs).toBe(2);
    expect(h.scheduler.status()[0]).toMatchObject({ running: false, runs: 2, failures: 0 });
  });

  test("a throwing job is logged, counted, and scheduled again; trigger() surfaces the error", async () => {
    const h = harness();
    let n = 0;
    h.scheduler.register({
      name: "flaky",
      intervalMs: 1000,
      run: () => {
        if (++n === 1) throw new Error("boom");
      },
    });
    h.scheduler.start();
    h.fire(1000);
    await tick();
    expect(h.scheduler.status()[0]).toMatchObject({ runs: 1, failures: 1, lastError: "boom" });
    expect(h.lines.some((l) => l.includes("scheduled job failed") && l.includes("flaky"))).toBe(
      true,
    );
    expect(h.delays()).toEqual([1000]);
    h.fire(1000);
    await tick();
    expect(h.scheduler.status()[0]).toMatchObject({ runs: 2, failures: 1, lastError: null });

    h.scheduler.register({
      name: "bad",
      intervalMs: 0,
      run: () => {
        throw new Error("nope");
      },
    });
    await expect(h.scheduler.trigger("bad")).rejects.toThrow("nope");
  });

  test("duplicate names are refused; registering after start arms at once", () => {
    const h = harness();
    h.scheduler.register({ name: "a", intervalMs: 1000, run: () => {} });
    expect(() => h.scheduler.register({ name: "a", intervalMs: 5, run: () => {} })).toThrow(
      "duplicate",
    );
    h.scheduler.start();
    h.scheduler.register({ name: "late", intervalMs: 2000, run: () => {} });
    expect(h.delays()).toEqual([1000, 2000]);
  });

  test("stop cancels timers, aborts the signal, and waits for the running job", async () => {
    const h = harness();
    const gate = deferred();
    let signal: AbortSignal | undefined;
    let finished = false;
    h.scheduler.register({ name: "idle", intervalMs: 5000, run: () => {} });
    h.scheduler.register({
      name: "busy",
      intervalMs: 1000,
      run: async (s) => {
        signal = s;
        await gate.promise;
        finished = true;
      },
    });
    h.scheduler.start();
    h.fire(1000);
    await tick();

    let stopped = false;
    const stopping = h.scheduler.stop(9999).then(() => {
      stopped = true;
    });
    expect(h.scheduler.stop()).toBe(h.scheduler.stop()); // idempotent
    await tick();
    expect(signal!.aborted).toBe(true);
    expect(stopped).toBe(false);
    expect(h.delays()).toEqual([9999]); // only the deadline remains
    gate.resolve();
    await stopping;
    expect(finished).toBe(true);
    expect(h.delays()).toEqual([]); // the deadline is cleaned up, and nothing re-armed
    await expect(h.scheduler.trigger("idle")).rejects.toThrow("stopped");
    expect(() => h.scheduler.register({ name: "x", intervalMs: 1, run: () => {} })).toThrow(
      "stopped",
    );
  });

  test("stop gives up at the deadline and names the job that would not finish", async () => {
    const h = harness();
    h.scheduler.register({ name: "stuck", intervalMs: 1000, run: () => new Promise(() => {}) });
    h.scheduler.start();
    h.fire(1000);
    await tick();
    const stopping = h.scheduler.stop(50);
    h.fire(50);
    await stopping;
    expect(h.lines.some((l) => l.includes("still running") && l.includes("stuck"))).toBe(true);
  });

  test("a job that fails BECAUSE of the abort is not reported as an error", async () => {
    const h = harness();
    h.scheduler.register({
      name: "obedient",
      intervalMs: 1000,
      run: (s) =>
        new Promise((_, rej) => s.addEventListener("abort", () => rej(new Error("aborted")))),
    });
    h.scheduler.start();
    h.fire(1000);
    await tick();
    await h.scheduler.stop();
    expect(h.lines.filter((l) => l.includes("scheduled job failed"))).toEqual([]);
  });

  test("with real timers: runs repeatedly and stops cleanly", async () => {
    let runs = 0;
    const s = new Scheduler({ logger: silentLogger() });
    s.register({
      name: "fast",
      intervalMs: 5,
      jitter: 0,
      run: () => {
        runs++;
      },
    });
    s.start();
    await Bun.sleep(60);
    await s.stop();
    const at = runs;
    expect(at).toBeGreaterThanOrEqual(3);
    await Bun.sleep(20);
    expect(runs).toBe(at);
  });
});
