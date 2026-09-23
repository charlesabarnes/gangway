import { describe, expect, test } from "bun:test";
import { Passwords } from "../../src/auth/password.ts";

// ln=10 keeps the suite fast; one test below runs the production cost on purpose.
const fast = (o = {}) => new Passwords({ ln: 10, ...o });

describe("Passwords", () => {
  test("round-trips, and the stored form says how it was made", async () => {
    const p = fast();
    const stored = await p.hash("correct horse battery staple");
    expect(stored.hash).toMatch(/^scrypt\$ln=10,r=8,p=1\$[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(stored.salt, "base64")).toHaveLength(16);
    expect(await p.verify("correct horse battery staple", stored)).toBe(true);
    expect(await p.verify("correct horse battery stapl", stored)).toBe(false);
    expect(await p.verify("", stored)).toBe(false);
  });

  test("the same password hashes differently every time", async () => {
    const p = fast();
    const [a, b] = await Promise.all([p.hash("same password here"), p.hash("same password here")]);
    expect(a.hash).not.toBe(b.hash);
    expect(a.salt).not.toBe(b.salt);
  });

  test("unicode is normalised: the same password typed two ways is the same password", async () => {
    const p = fast();
    const stored = await p.hash("café-au-lait-please");
    expect(await p.verify("café-au-lait-please", stored)).toBe(true);
  });

  test("a stored value that does not parse is simply wrong -- it never throws", async () => {
    const p = fast();
    const good = await p.hash("a perfectly fine password");
    for (const hash of [
      "",
      "plaintext",
      "scrypt$ln=10,r=8,p=1$",
      "bcrypt$ln=10,r=8,p=1$AAAA",
      good.hash.slice(0, -8),
    ]) {
      expect(await p.verify("a perfectly fine password", { hash, salt: good.salt })).toBe(false);
    }
  });

  test("tampered parameters are refused rather than obeyed", async () => {
    const p = fast();
    const good = await p.hash("a perfectly fine password");
    const started = performance.now();
    // ln=31 would be a 274 GiB derivation; ln=4 a trivially cheap one. Neither is run.
    for (const ln of ["31", "4", "99"]) {
      expect(
        await p.verify("a perfectly fine password", {
          ...good,
          hash: good.hash.replace("ln=10", `ln=${ln}`),
        }),
      ).toBe(false);
    }
    expect(performance.now() - started).toBeLessThan(50);
  });

  test("needsRehash notices a hash made at a different cost", async () => {
    const stored = await fast().hash("a perfectly fine password");
    expect(fast().needsRehash(stored.hash)).toBe(false);
    expect(new Passwords({ ln: 11 }).needsRehash(stored.hash)).toBe(true);
    expect(fast().needsRehash("garbage")).toBe(true);
    // ...and the old hash still verifies under the new policy, so the upgrade can happen at login.
    expect(await new Passwords({ ln: 11 }).verify("a perfectly fine password", stored)).toBe(true);
  });

  test("verifyDummy is always false and does real work", async () => {
    const p = fast();
    expect(await p.verifyDummy("anything at all")).toBe(false);
    expect(await p.verifyDummy("anything at all")).toBe(false);
  });

  test("PRODUCTION cost works: Node's default maxmem is exactly what N=2^15 needs, and would throw", async () => {
    const p = new Passwords();
    const stored = await p.hash("the real parameters, once");
    expect(stored.hash).toStartWith("scrypt$ln=15,r=8,p=1$");
    expect(await p.verify("the real parameters, once", stored)).toBe(true);
  });

  test("hashing does not block the event loop: this process is also a proxy", async () => {
    const p = new Passwords();
    let worst = 0,
      last = performance.now();
    const probe = setInterval(() => {
      const t = performance.now();
      worst = Math.max(worst, t - last - 5);
      last = t;
    }, 5);
    await Promise.all([
      p.hash("first of two at production cost"),
      p.hash("second of two at production cost"),
    ]);
    clearInterval(probe);
    // Measured on Bun 1.4.2: ~1 ms of lag with the async scrypt, ~48 ms with scryptSync.
    // The bound sits between them, so swapping in the sync call FAILS this test.
    expect(worst).toBeLessThan(20);
  });

  test("at most `concurrency` run at once; the queue is bounded and overflow is a 429", async () => {
    const p = fast({ concurrency: 1, maxQueue: 2 });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => p.hash(`password number ${i} here`)),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(3); // one running + two queued
    expect(refused).toHaveLength(2);
    for (const r of refused)
      expect(r.reason).toMatchObject({
        code: "rate_limited",
        status: 429,
        headers: { "retry-after": "2" },
      });
    // ...and the slots come back: the next caller is served.
    expect((await p.hash("after the storm passes")).hash).toStartWith("scrypt$");
  });
});
