/** Idle-sleep and wake (§7.4, ADR-0012) through the real pipeline with a fake compose. */
import { describe, expect, test } from "bun:test";
import { Logger } from "../../src/logger.ts";
import { fixedPolicy } from "../../src/previews/policy.ts";
import { Waker, sleepPreview, sweepIdle } from "../../src/previews/sleep.ts";
import { setupPreviewContext } from "../helpers/preview-context.ts";

const quiet = new Logger("error", {}, () => {});
const MIN = 60_000;

describe("sleepPreview", () => {
  test("stops the WHOLE project, file-less by -p, and the row and every route say asleep", async () => {
    const s = setupPreviewContext();
    const p = await s.deployed("night");
    const slept = await sleepPreview(s.ctx, p.id, "idle for 31 min");
    expect(slept.state).toBe("asleep");
    expect(s.fake.stops).toHaveLength(1);
    const argv = s.fake.stops[0]!;
    expect(argv).toContain("--project-name");
    expect(argv[argv.indexOf("--project-name") + 1]).toBe(p.project);
    expect(argv).not.toContain("--file");
    expect(s.ctx.table.forPreview(p.id).every((e) => e.state === "asleep")).toBe(true);
    expect(s.ctx.logs.tail(p.id).join("\n")).toContain("asleep: idle for 31 min");
    await expect(sleepPreview(s.ctx, p.id, "again")).rejects.toMatchObject({ code: "conflict" });
  });

  test("a stop that fails leaves the preview awake", async () => {
    const s = setupPreviewContext();
    const p = await s.deployed("stuck");
    s.fake.stopExit = 1;
    await expect(sleepPreview(s.ctx, p.id, "idle")).rejects.toThrow(/compose stop exited 1/);
    expect(s.previews.get(p.id)!.state).toBe("awake");
  });
});

describe("sweepIdle", () => {
  test("the template's window: a preview unseen for longer than it sleeps; a fresh one does not; a visit noted in memory counts", async () => {
    const s = setupPreviewContext();
    s.ctx.policy = fixedPolicy({ idleAfter: "30m" });
    const old = await s.deployed("old");
    const fresh = await s.deployed("fresh");
    const visited = await s.deployed("visited");
    s.previews.touch(old.id, s.ctx.now() - 31 * MIN);
    s.previews.touch(fresh.id, s.ctx.now() - 5 * MIN);
    s.previews.touch(visited.id, s.ctx.now() - 31 * MIN);
    // The proxy saw `visited` a moment ago; only the in-memory table knows.
    s.ctx.table.touch(s.ctx.table.forPreview(visited.id)[0]!.hostname, s.ctx.now());
    const r = await sweepIdle(s.ctx, quiet);
    expect(r).toMatchObject({ candidates: 1, slept: [old.id], skipped: [], failed: [] });
    expect(s.previews.get(old.id)!.state).toBe("asleep");
    expect(s.previews.get(fresh.id)!.state).toBe("awake");
    expect(s.previews.get(visited.id)!.state).toBe("awake");
  });

  test("never seen: created_at counts; the row's own window is what counts; 0 means never; a row from before templates (NULL) uses the default template's", async () => {
    const s = setupPreviewContext();
    s.ctx.policy = fixedPolicy({ idleAfter: "30m" });
    const a = await s.deployed("a");
    const b = await s.deployed("b");
    const c = await s.deployed("c");
    const d = await s.deployed("d");
    expect(s.previews.get(a.id)!.idleAfterMs).toBe(30 * MIN); // pinned from the template at deploy
    s.db.run("UPDATE previews SET created_at = $t WHERE id IN ($a, $b, $c, $d)", {
      t: s.ctx.now() - 10 * MIN,
      a: a.id,
      b: b.id,
      c: c.id,
      d: d.id,
    });
    s.db.run("UPDATE previews SET idle_after_ms = 5 * 60000 WHERE id = $b", { b: b.id });
    s.db.run("UPDATE previews SET idle_after_ms = 0 WHERE id = $c", { c: c.id });
    s.db.run("UPDATE previews SET idle_after_ms = NULL WHERE id = $d", { d: d.id });
    s.previews.touch(c.id, s.ctx.now() - 500 * MIN);
    s.ctx.policy = fixedPolicy({ idleAfter: "8m" }); // the default template, edited after the deploys
    const r = await sweepIdle(s.ctx, quiet);
    expect(r.slept.sort()).toEqual([b.id, d.id].sort()); // a: 10 < its pinned 30; b: 10 > its own 5; c: never; d: 10 > the default's 8
  });

  test("a template that never sleeps (idleAfter never -> 0 pinned): nothing ever sleeps", async () => {
    const s = setupPreviewContext();
    const p = await s.deployed("p");
    expect(s.previews.get(p.id)!.idleAfterMs).toBe(0);
    s.previews.touch(p.id, s.ctx.now() - 10_000 * MIN);
    expect((await sweepIdle(s.ctx, quiet)).candidates).toBe(0);
  });

  test("a preview on an unreachable host, or one being torn down, is skipped", async () => {
    const s = setupPreviewContext();
    s.ctx.policy = fixedPolicy({ idleAfter: "1m" });
    const p = await s.deployed("far");
    s.previews.touch(p.id, s.ctx.now() - 5 * MIN);
    s.ctx.teardowns.add(p.id);
    expect((await sweepIdle(s.ctx, quiet)).skipped).toEqual([p.id]);
    s.ctx.teardowns.delete(p.id);
    s.hosts.setState("local", "unreachable");
    expect((await sweepIdle(s.ctx, quiet)).skipped).toEqual([p.id]);
  });
});

describe("Waker", () => {
  test("asleep -> starting -> awake: compose start file-less, then healthy, then answering; the routes follow", async () => {
    const s = setupPreviewContext();
    const p = await s.deployed("dawn");
    await sleepPreview(s.ctx, p.id, "idle");
    const waker = new Waker(s.ctx, quiet);
    const woke = await waker.wake(p.id);
    expect(woke.state).toBe("awake");
    expect(s.fake.starts).toHaveLength(1);
    expect(s.fake.starts[0]).not.toContain("--file");
    expect(s.ctx.table.forPreview(p.id).every((e) => e.state === "awake")).toBe(true);
    expect(s.ctx.logs.tail(p.id).join("\n")).toMatch(/waking[\s\S]*awake/);
    // Already awake: a no-op that resolves.
    expect((await waker.wake(p.id)).state).toBe("awake");
    expect(s.fake.starts).toHaveLength(1);
  });

  test("a wake is IN FLIGHT while it runs, so the reconciler leaves its `starting` alone (found live with a slow Postgres add-on)", async () => {
    const s = setupPreviewContext();
    const p = await s.deployed("slow");
    await sleepPreview(s.ctx, p.id, "idle");
    let during = false as boolean;
    const probe = s.ctx.probe;
    s.ctx.probe = async (r, h, path) => {
      during = s.ctx.inflight.has(p.id);
      return probe(r, h, path);
    };
    await new Waker(s.ctx, quiet).wake(p.id);
    expect(during).toBe(true);
    expect(s.ctx.inflight.has(p.id)).toBe(false);
  });

  test("concurrent requests share ONE wake", async () => {
    const s = setupPreviewContext();
    const p = await s.deployed("crowd");
    await sleepPreview(s.ctx, p.id, "idle");
    const waker = new Waker(s.ctx, quiet);
    const all = await Promise.all([waker.wake(p.id), waker.wake(p.id), waker.wake(p.id)]);
    expect(all.every((x) => x.state === "awake")).toBe(true);
    expect(s.fake.starts).toHaveLength(1);
  });

  test("a wake that fails goes back to ASLEEP with the reason in the log, never to failed; the next request tries again", async () => {
    const s = setupPreviewContext();
    const p = await s.deployed("stumble");
    await sleepPreview(s.ctx, p.id, "idle");
    const waker = new Waker(s.ctx, quiet);
    s.fake.startExit = 1;
    await expect(waker.wake(p.id)).rejects.toThrow(/compose start exited 1/);
    expect(s.previews.get(p.id)!.state).toBe("asleep");
    expect(s.ctx.logs.tail(p.id).join("\n")).toContain("wake failed: compose start exited 1");
    s.fake.startExit = 0;
    s.fake.answering = false;
    await expect(waker.wake(p.id)).rejects.toThrow(/never answered HTTP/);
    expect(s.previews.get(p.id)!.state).toBe("asleep");
    s.fake.answering = true;
    expect((await waker.wake(p.id)).state).toBe("awake");
  });

  test("not asleep is a conflict; unknown is not found", async () => {
    const s = setupPreviewContext();
    const p = await s.deployed("up");
    const waker = new Waker(s.ctx, quiet);
    expect((await waker.wake(p.id)).state).toBe("awake");
    await expect(waker.wake("nope")).rejects.toMatchObject({ code: "not_found" });
  });
});
