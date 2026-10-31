import { describe, expect, test } from "bun:test";
import { Waker, sleepPreview } from "../../src/previews/sleep.ts";
import { setupPreviewContext } from "../helpers/preview-context.ts";
import { silentLogger } from "../helpers/logger.ts";

const quiet = silentLogger();
const MIN = 60_000;

describe("awake limit", () => {
  test("a wake past the org's limit sleeps its least recently seen preview", async () => {
    const s = setupPreviewContext();
    const old = await s.deployed("old");
    const recent = await s.deployed("recent");
    const dawn = await s.deployed("dawn");
    await sleepPreview(s.ctx, dawn.id, "idle");
    s.previews.touch(old.id, s.ctx.now() - 30 * MIN);
    s.previews.touch(recent.id, s.ctx.now() - 5 * MIN);
    s.ctx.orgLimits = () => ({ maxAwake: 2 });
    expect((await new Waker(s.ctx, quiet).wake(dawn.id)).state).toBe("awake");
    expect(s.previews.get(old.id)!.state).toBe("asleep");
    expect(s.previews.get(recent.id)!.state).toBe("awake");
    expect(s.ctx.logs.tail(dawn.id).join("\n")).toContain("the org's plan allows 2 awake");
    expect(s.ctx.logs.tail(old.id).join("\n")).toContain("asleep: the org's plan allows 2 awake");
  });

  test("a visit gangway has not written down yet still counts as seen", async () => {
    const s = setupPreviewContext();
    const a = await s.deployed("a");
    const b = await s.deployed("b");
    const c = await s.deployed("c");
    await sleepPreview(s.ctx, c.id, "idle");
    s.previews.touch(a.id, s.ctx.now() - 30 * MIN);
    s.previews.touch(b.id, s.ctx.now() - 20 * MIN);
    s.ctx.table.touch(s.ctx.table.forPreview(a.id)[0]!.hostname, s.ctx.now());
    s.ctx.orgLimits = () => ({ maxAwake: 2 });
    await new Waker(s.ctx, quiet).wake(c.id);
    expect(s.previews.get(a.id)!.state).toBe("awake");
    expect(s.previews.get(b.id)!.state).toBe("asleep");
  });

  test("a new deploy past the limit sleeps the oldest; with no limit nothing sleeps", async () => {
    const s = setupPreviewContext();
    const first = await s.deployed("first");
    await s.deployed("second");
    expect(s.fake.stops).toHaveLength(0);
    s.ctx.orgLimits = () => ({ maxAwake: 2 });
    s.previews.touch(first.id, s.ctx.now() - 10 * MIN);
    await s.deployed("third");
    expect(s.previews.get(first.id)!.state).toBe("asleep");
    expect(s.previews.list({ state: "awake" })).toHaveLength(2);
  });

  test("a busy preview is never slept, and the wake goes ahead anyway", async () => {
    const s = setupPreviewContext();
    const busy = await s.deployed("busy");
    const dawn = await s.deployed("dawn");
    await sleepPreview(s.ctx, dawn.id, "idle");
    s.ctx.teardowns.add(busy.id);
    s.ctx.orgLimits = () => ({ maxAwake: 1 });
    expect((await new Waker(s.ctx, quiet).wake(dawn.id)).state).toBe("awake");
    expect(s.previews.get(busy.id)!.state).toBe("awake");
  });

  test("another org's previews neither count nor sleep", async () => {
    const s = setupPreviewContext();
    const theirs = await s.deployed("theirs");
    s.db.run(
      "INSERT INTO orgs (id, slug, name, created_at, updated_at) VALUES ('o2', 'two', 'Two', 1, 1)",
    );
    s.db.run("UPDATE previews SET org_id = 'o2' WHERE id = $id", { id: theirs.id });
    const dawn = await s.deployed("dawn");
    await sleepPreview(s.ctx, dawn.id, "idle");
    s.ctx.orgLimits = () => ({ maxAwake: 1 });
    await new Waker(s.ctx, quiet).wake(dawn.id);
    expect(s.previews.get(theirs.id)!.state).toBe("awake");
  });

  test("a preview destroyed while room is made leaves no wake behind", async () => {
    const s = setupPreviewContext();
    const dawn = await s.deployed("dawn");
    await sleepPreview(s.ctx, dawn.id, "idle");
    s.ctx.orgLimits = () => {
      s.db.run("UPDATE previews SET state = 'destroyed' WHERE id = $id", { id: dawn.id });
      return undefined;
    };
    await expect(new Waker(s.ctx, quiet).wake(dawn.id)).rejects.toThrow();
    expect(s.ctx.inflight.has(dawn.id)).toBe(false);
  });
});
