import { describe, expect, test } from "bun:test";
import { SingleFlight, backoffDelay, retry, waitFor } from "../../src/util/async.ts";
import { ULID_RE, isUlid, ulid } from "../../src/util/ulid.ts";
import { Logger, redact, redactString } from "../../src/logger.ts";
import { AppError, notFound } from "../../src/errors.ts";

describe("ulid", () => {
  test("shape", () => expect(ULID_RE.test(ulid())).toBe(true));
  test("sorts chronologically", () => {
    const a = ulid(1000), b = ulid(2000), c = ulid(3000);
    expect([c, a, b].sort()).toEqual([a, b, c]);
  });
  test("monotonic within one millisecond", () => {
    const ids = Array.from({ length: 200 }, () => ulid(5000));
    expect(new Set(ids).size).toBe(200);
    expect([...ids].sort()).toEqual(ids);
  });
  test("rejects non-ulids", () => {
    expect(isUlid("nope")).toBe(false);
    expect(isUlid("0000000000000000000000000I")).toBe(false); // I is not in Crockford base32
  });
});

describe("redaction", () => {
  test.each([
    ["token gw_abcdefghijklmnopqrstuvwx here", "gw_"],
    ["ghp_0123456789abcdefghij0123456789", "ghp_"],
    ["Authorization: Bearer abcdefghijklmnop.qrst", "Bearer"],
    ["https://user:hunter2secret@github.com/x.git", "hunter2secret"],
  ])("redacts %s", (input, needle) => {
    expect(redactString(input)).not.toContain(needle === "Bearer" ? "abcdefghijklmnop" : needle);
    expect(redactString(input)).toContain("[redacted]");
  });

  test("redacts a private key block", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIBVQIBADAN\n-----END PRIVATE KEY-----";
    expect(redactString(pem)).toBe("[redacted]");
  });

  test("redacts by field name whatever the value looks like", () => {
    const o = redact({ password: "hunter2", nested: { apiToken: "plain" }, keep: "visible" }) as any;
    expect(o.password).toBe("[redacted]");
    expect(o.nested.apiToken).toBe("[redacted]");
    expect(o.keep).toBe("visible");
  });

  test("log lines are redacted end to end", () => {
    const lines: string[] = [];
    new Logger("info", {}, (l) => lines.push(l))
      .info("cloning with gw_abcdefghijklmnopqrstuvwx", { token: "secret", repo: "acme" });
    const rec = JSON.parse(lines[0]!);
    expect(rec.msg).toContain("[redacted]");
    expect(rec.token).toBe("[redacted]");
    expect(rec.repo).toBe("acme");
  });

  test("respects the level threshold", () => {
    const lines: string[] = [];
    const log = new Logger("warn", {}, (l) => lines.push(l));
    log.info("ignored"); log.error("kept");
    expect(lines).toHaveLength(1);
  });

  test("survives a cyclic object", () => {
    const a: any = { name: "a" }; a.self = a;
    expect(() => redact(a)).not.toThrow();
  });
});

describe("SingleFlight", () => {
  test("collapses concurrent calls on one key", async () => {
    const sf = new SingleFlight<number>();
    let calls = 0;
    const fn = async () => { calls++; await Bun.sleep(20); return 42; };
    const all = await Promise.all(Array.from({ length: 60 }, () => sf.run("preview-1", fn)));
    expect(calls).toBe(1);
    expect(all.every((v) => v === 42)).toBe(true);
    expect(sf.size).toBe(0);
  });

  test("different keys do not collapse", async () => {
    const sf = new SingleFlight<string>();
    let calls = 0;
    const fn = async () => { calls++; return "x"; };
    await Promise.all([sf.run("a", fn), sf.run("b", fn)]);
    expect(calls).toBe(2);
  });

  test("a rejection clears the slot so the next call retries", async () => {
    const sf = new SingleFlight<number>();
    await expect(sf.run("k", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(sf.has("k")).toBe(false);
    expect(await sf.run("k", async () => 1)).toBe(1);
  });
});

describe("retry / backoff", () => {
  test("delay grows and is capped", () => {
    const r = () => 1; // full jitter -> take the ceiling
    expect(backoffDelay(0, { baseMs: 100, random: r })).toBe(100);
    expect(backoffDelay(3, { baseMs: 100, random: r })).toBe(800);
    expect(backoffDelay(20, { baseMs: 100, maxMs: 5000, random: r })).toBe(5000);
  });

  test("succeeds after transient failures", async () => {
    let n = 0;
    const v = await retry(async () => { if (++n < 3) throw new Error("nope"); return n; },
      { baseMs: 1, random: () => 0 });
    expect(v).toBe(3);
  });

  test("gives up after the attempt budget", async () => {
    let n = 0;
    await expect(retry(async () => { n++; throw new Error("always"); }, { attempts: 3, baseMs: 1, random: () => 0 }))
      .rejects.toThrow("always");
    expect(n).toBe(3);
  });

  test("shouldRetry short-circuits non-retryable errors", async () => {
    let n = 0;
    await expect(retry(async () => { n++; throw new AppError("bad_request", "no"); },
      { attempts: 5, baseMs: 1, shouldRetry: (e) => !(e instanceof AppError) })).rejects.toThrow("no");
    expect(n).toBe(1);
  });
});

describe("waitFor", () => {
  test("returns as soon as a value appears", async () => {
    let n = 0;
    expect(await waitFor(async () => (++n >= 3 ? "ready" : null), { timeoutMs: 1000, intervalMs: 5 })).toBe("ready");
  });
  test("returns null at the deadline instead of hanging", async () => {
    expect(await waitFor(async () => null, { timeoutMs: 40, intervalMs: 10 })).toBeNull();
  });
});

describe("AppError", () => {
  test("maps to a status and problem+json", () => {
    const p = notFound("preview not found", { previewId: "x" }).toProblem("/v1/previews/x");
    expect(p.status).toBe(404);
    expect(p.instance).toBe("/v1/previews/x");
    expect((p as any).previewId).toBe("x");
  });
});

describe("drain", () => {
  test("returns true as soon as the condition holds, false at the deadline", async () => {
    const { drain } = await import("../../src/util/async.ts");
    expect(await drain(() => true, { timeoutMs: 0 })).toBe(true);
    let n = 0;
    expect(await drain(() => ++n >= 3, { timeoutMs: 1_000, intervalMs: 1 })).toBe(true);
    const began = Date.now();
    expect(await drain(() => false, { timeoutMs: 40, intervalMs: 5 })).toBe(false);
    expect(Date.now() - began).toBeLessThan(500);
  });
});
