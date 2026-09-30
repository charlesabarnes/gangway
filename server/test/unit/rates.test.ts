import { describe, expect, test } from "bun:test";
import { RequestRates, type RateLimits } from "../../src/net/rates.ts";

function rates(l: Partial<RateLimits> = {}) {
  const clock = { now: 0 };
  const reports: number[] = [];
  const limits = { perClient: 60, perPreview: 0, socketsPerClient: 2, ...l };
  const r = new RequestRates(() => limits, {
    now: () => clock.now,
    report: (n) => reports.push(n),
  });
  return { r, clock, reports, limits };
}

describe("request rates", () => {
  test("a minute's worth goes through at once, then one a second", () => {
    const { r, clock } = rates();
    for (let i = 0; i < 60; i++) {
      expect(r.take("203.0.113.1", "p1")).toBeNull();
    }
    expect(r.take("203.0.113.1", "p1")).toBe(1);
    clock.now += 1_000;
    expect(r.take("203.0.113.1", "p1")).toBeNull();
    expect(r.take("203.0.113.2", "p1")).toBeNull();
  });

  test("an IPv6 client is its /64", () => {
    const { r } = rates({ perClient: 1 });
    expect(r.take("2001:db8:1:2::1", "p1")).toBeNull();
    expect(r.take("2001:db8:1:2::ffff", "p1")).toBe(60);
    expect(r.take("2001:db8:1:3::1", "p1")).toBeNull();
  });

  test("a preview's own limit counts everyone together; 0 is off", () => {
    const { r, limits } = rates({ perClient: 0, perPreview: 2 });
    expect(r.take("a", "p1")).toBeNull();
    expect(r.take("b", "p1")).toBeNull();
    expect(r.take("c", "p1")).toBe(30);
    expect(r.take("c", "p2")).toBeNull();
    limits.perPreview = 0;
    expect(r.take("c", "p1")).toBeNull();
  });

  test("sockets are counted in and out", () => {
    const { r } = rates();
    const a = r.openSocket("203.0.113.1")!;
    const b = r.openSocket("203.0.113.1")!;
    expect(r.openSocket("203.0.113.1")).toBeNull();
    a();
    a();
    expect(r.openSocket("203.0.113.1")).not.toBeNull();
    b();
  });

  test("refusals are reported at most once a minute", () => {
    const { r, clock, reports } = rates({ perClient: 1 });
    clock.now = 60_000;
    r.take("x", "p");
    r.take("x", "p");
    r.take("x", "p");
    expect(reports).toEqual([1]);
    clock.now += 60_000;
    r.take("x", "p");
    r.take("x", "p");
    expect(reports).toEqual([1, 2]);
  });
});
