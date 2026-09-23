import { describe, expect, test } from "bun:test";
import { LoginLimiter, sourceKey } from "../../src/auth/limiter.ts";

const MIN = 60_000;

function make(o = {}) {
  let clock = 1_700_000_000_000;
  const limiter = new LoginLimiter(o, () => clock);
  return {
    limiter,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe("sourceKey", () => {
  test.each([
    ["203.0.113.7", "203.0.113.7"],
    ["2001:db8:aa:bb:1:2:3:4", "2001:db8:aa:bb::/64"],
    ["2001:db8:aa:bb::1", "2001:db8:aa:bb::/64"],
    ["2001:0db8:00aa:00bb::ffff", "2001:db8:aa:bb::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["fe80::1%en0", "fe80:0:0:0::/64"],
  ])("%s -> %s", (ip, want) => expect(sourceKey(ip)).toBe(want));

  test("every address in one /64 is one source", () => {
    expect(sourceKey("2001:db8:1:2:aaaa::1")).toBe(sourceKey("2001:db8:1:2:bbbb:cccc:dddd:eeee"));
    expect(sourceKey("2001:db8:1:2::1")).not.toBe(sourceKey("2001:db8:1:3::1"));
  });
});

describe("LoginLimiter", () => {
  test("an account gets 5 free failures, then a lock that doubles and is capped", () => {
    const { limiter, tick } = make({ ipMax: 1000 });
    const email = "ada@example.com";
    for (let i = 0; i < 4; i++) {
      limiter.fail("198.51.100.1", email);
      expect(limiter.check("198.51.100.1", email).ok).toBe(true);
    }

    const locks: number[] = [];
    for (let i = 0; i < 7; i++) {
      limiter.fail("198.51.100.1", email);
      const v = limiter.check("198.51.100.1", email);
      if (v.ok) throw new Error("expected a lock");
      expect(v.reason).toBe("email");
      locks.push(v.retryAfterSec);
      tick(v.retryAfterSec * 1000);
      expect(limiter.check("198.51.100.1", email).ok).toBe(true);
    }
    expect(locks).toEqual([60, 120, 240, 480, 900, 900, 900]);
  });

  test("the account lock holds no matter which address asks", () => {
    const { limiter } = make();
    for (let i = 0; i < 5; i++) limiter.fail(`198.51.100.${i}`, "ada@example.com");
    expect(limiter.check("203.0.113.99", "ada@example.com").ok).toBe(false);
    expect(limiter.check("203.0.113.99", "bob@example.com").ok).toBe(true);
  });

  test("one source spraying many accounts is stopped at 10 failures, until the oldest ages out", () => {
    const { limiter, tick } = make();
    for (let i = 0; i < 10; i++) {
      expect(limiter.check("203.0.113.7", `user${i}@example.com`).ok).toBe(true);
      limiter.fail("203.0.113.7", `user${i}@example.com`);
      tick(1000);
    }
    const v = limiter.check("203.0.113.7", "fresh@example.com");
    expect(v).toEqual({ ok: false, retryAfterSec: 15 * 60 - 10, reason: "ip" });
    expect(limiter.check("203.0.113.8", "fresh@example.com").ok).toBe(true);
    tick(15 * MIN - 10_000);
    expect(limiter.check("203.0.113.7", "fresh@example.com").ok).toBe(true);
  });

  test("a whole IPv6 /64 is one source", () => {
    const { limiter } = make();
    for (let i = 0; i < 10; i++) limiter.fail(`2001:db8:1:2::${i + 1}`, `user${i}@example.com`);
    expect(limiter.check("2001:db8:1:2:ffff:ffff:ffff:ffff", "x@example.com").ok).toBe(false);
    expect(limiter.check("2001:db8:1:3::1", "x@example.com").ok).toBe(true);
  });

  test("success clears the account's streak but NOT the source's", () => {
    const { limiter } = make();
    for (let i = 0; i < 4; i++) limiter.fail("203.0.113.7", "ada@example.com");
    limiter.succeed("ada@example.com");
    for (let i = 0; i < 4; i++) limiter.fail("203.0.113.7", "ada@example.com");
    expect(limiter.check("203.0.113.7", "ada@example.com").ok).toBe(true); // streak restarted at 0
    // ...but those 8 failures still count against the address: logging in to your own
    // account must not buy fresh guesses at someone else's.
    limiter.fail("203.0.113.7", "bob@example.com");
    limiter.fail("203.0.113.7", "bob@example.com");
    expect(limiter.check("203.0.113.7", "carol@example.com")).toMatchObject({
      ok: false,
      reason: "ip",
    });
  });

  test("a streak is forgotten after an hour of quiet", () => {
    const { limiter, tick } = make({ ipMax: 1000 });
    for (let i = 0; i < 4; i++) limiter.fail("203.0.113.7", "ada@example.com");
    tick(61 * MIN);
    limiter.fail("203.0.113.7", "ada@example.com");
    expect(limiter.check("203.0.113.7", "ada@example.com").ok).toBe(true);
  });

  test("memory is bounded, and flooding addresses cannot evict an account's lock", () => {
    const { limiter } = make({ maxKeys: 100 });
    for (let i = 0; i < 5; i++) limiter.fail("198.51.100.1", "ada@example.com");
    for (let i = 0; i < 5000; i++)
      limiter.fail(`10.${(i >> 8) & 255}.${i & 255}.1`, "ada@example.com");
    expect(limiter.trackedKeys).toEqual({ ips: 100, emails: 1 });
    expect(limiter.check("203.0.113.200", "ada@example.com").ok).toBe(false);
  });
});
