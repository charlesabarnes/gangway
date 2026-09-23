import { describe, expect, test } from "bun:test";
import { actorId, can, systemActor } from "../../src/auth/actor.ts";
import { flushLastSeen, sweepExpired } from "../../src/scheduler/jobs.ts";
import { DAY, setupPreviewContext as setup } from "../helpers/preview-context.ts";

describe("systemActor", () => {
  test("is an admin whose id cannot be mistaken for a real token's", () => {
    const a = systemActor("ttl-sweep");
    expect(actorId(a)).toBe("system:ttl-sweep");
    expect(can(a, "previews.destroy")).toBe(true);
  });
});

describe("sweepExpired", () => {
  test("a preview inside its TTL is left alone", async () => {
    const s = setup();
    const p = await s.deployed("fresh");
    expect(p.ttlExpiresAt).not.toBeNull();
    const r = await sweepExpired(s.ctx, s.logger);
    expect(r).toEqual({ expired: 0, destroyed: [], skipped: [], failed: [] });
    expect(s.fake.downs).toEqual([]);
    expect(s.lines).toEqual([]);
  });

  test("destroys an expired preview through the normal lifecycle, once", async () => {
    const s = setup();
    const p = await s.deployed("old");
    s.clock.offset = 8 * DAY;
    const r = await sweepExpired(s.ctx, s.logger);
    expect(r.destroyed).toEqual([p.id]);
    expect(s.fake.downs).toEqual([p.project]);
    expect(s.previews.get(p.id)!.state).toBe("destroyed");
    expect(s.routes.forPreview(p.id)).toEqual([]);
    expect(s.table.forPreview(p.id)).toEqual([]);
    expect((await sweepExpired(s.ctx, s.logger)).expired).toBe(0);
  });

  test("skips a preview on an unreachable host rather than failing it", async () => {
    const s = setup();
    const p = await s.deployed("stranded");
    s.clock.offset = 8 * DAY;
    s.hosts.setState(p.hostId, "unreachable", "tunnel down");
    const r = await sweepExpired(s.ctx, s.logger);
    expect(r).toMatchObject({ expired: 1, skipped: [p.id], destroyed: [], failed: [] });
    expect(s.fake.downs).toEqual([]);
    expect(s.previews.get(p.id)!.state).toBe("awake");

    s.hosts.setState(p.hostId, "ready", null);
    expect((await sweepExpired(s.ctx, s.logger)).destroyed).toEqual([p.id]);
  });

  test("one preview that will not die does not shield the ones behind it", async () => {
    const s = setup();
    const a = await s.deployed("stuck");
    const b = await s.deployed("fine");
    s.fake.failDownFor.add(a.project);
    s.clock.offset = 8 * DAY;
    const r = await sweepExpired(s.ctx, s.logger);
    expect(r.failed).toEqual([a.id]);
    expect(r.destroyed).toEqual([b.id]);
    expect(s.previews.get(a.id)!.state).toBe("failed");
    expect(s.lines.some((l) => l.includes("could not destroy"))).toBe(true);
  });

  test("a teardown already running in this process is left to finish", async () => {
    const s = setup();
    const p = await s.deployed("going");
    s.clock.offset = 8 * DAY;
    s.ctx.teardowns.add(p.id);
    expect((await sweepExpired(s.ctx, s.logger)).skipped).toEqual([p.id]);
  });

  test("an aborted signal stops the sweep between previews", async () => {
    const s = setup();
    await s.deployed("one");
    await s.deployed("two");
    s.clock.offset = 8 * DAY;
    const r = await sweepExpired(s.ctx, s.logger, AbortSignal.abort());
    expect(r).toMatchObject({ expired: 2, destroyed: [] });
  });
});

describe("flushLastSeen", () => {
  test("writes the newest visit per preview, once, and never bumps updated_at", async () => {
    const s = setup();
    const p = await s.deployed("visited");
    const q = await s.deployed("ignored");
    const hostname = s.routes.forPreview(p.id)[0]!.hostname;
    const before = s.previews.get(p.id)!.updatedAt;

    s.table.touch(hostname, 1_000);
    s.table.touch(hostname, 5_000);
    s.table.touch("nobody.preview.localhost", 9_000);
    expect(flushLastSeen(s.ctx)).toBe(1);
    expect(s.previews.get(p.id)!.lastSeenAt?.getTime()).toBe(5_000);
    expect(s.previews.get(p.id)!.updatedAt).toEqual(before);
    expect(s.previews.get(q.id)!.lastSeenAt).toBeNull();

    expect(flushLastSeen(s.ctx)).toBe(0);
  });

  test("never moves last_seen_at backwards", async () => {
    const s = setup();
    const p = await s.deployed("clock");
    const hostname = s.routes.forPreview(p.id)[0]!.hostname;
    s.previews.touch(p.id, 9_000);
    s.table.touch(hostname, 4_000);
    expect(flushLastSeen(s.ctx)).toBe(0);
    expect(s.previews.get(p.id)!.lastSeenAt?.getTime()).toBe(9_000);
  });

  test("skips a preview destroyed between the visit and the flush", async () => {
    const s = setup();
    const p = await s.deployed("gone");
    s.table.touch(s.routes.forPreview(p.id)[0]!.hostname, 4_000);
    s.table.removePreview(p.id);
    expect(flushLastSeen(s.ctx)).toBe(0);
  });
});
