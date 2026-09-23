import { describe, expect, test } from "bun:test";
import { LoginLimiter } from "../../src/auth/limiter.ts";
import { PASSWORD_COOKIE, stripGangwayCookies } from "../../src/net/gate.ts";
import { generatePassword } from "../../src/previews/password.ts";
import { entry, HOST, makeGate, passwords } from "../helpers/preview-password.ts";

const own = async (password = "correct horse") =>
  ({ mode: "own", ...(await passwords.hash(password)) }) as const;

describe("the password gate", () => {
  test("an open preview passes straight through", async () => {
    const t = makeGate();
    expect(t.get(entry({ mode: "none" }))).toBeNull();
    expect(t.get(entry({ mode: "inherit" }))).toBeNull();
  });

  test("a page load gets gangway's form, not the preview; a fetch gets a plain 401", async () => {
    const t = makeGate();
    const e = entry(await own());
    const res = (await t.get(e, "/orders?x=1"))!;
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain('action="/__gangway/password"');
    expect(html).toContain('value="/orders?x=1"');
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const api = (await t.gate.handle(
      e,
      new Request(`https://${HOST}/api`, { headers: { "sec-fetch-mode": "cors" } }),
    ))!;
    expect(api.status).toBe(401);
    expect(api.headers.get("content-type")).toContain("text/plain");
  });

  test("the right password sets a cookie that opens it; the wrong one does not", async () => {
    const t = makeGate();
    const e = entry(await own());
    const wrong = await t.post(e, "nope nope");
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(t.failures).toEqual(["wrong"]);

    const right = await t.post(e, "correct horse", "/orders");
    expect(right.status).toBe(303);
    expect(right.headers.get("location")).toBe("/orders");
    expect(right.headers.get("set-cookie")).toContain(`${PASSWORD_COOKIE}=`);
    expect(right.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Lax");
    expect(t.get(e, "/orders", { cookie: t.cookieOf(right) })).toBeNull();
    expect(stripGangwayCookies(`a=1; ${t.cookieOf(right)}`)).toBe("a=1");
  });

  test("a cookie is retired by a password change or on another preview's id", async () => {
    const t = makeGate();
    const e = entry(await own("first password"));
    const cookie = t.cookieOf(await t.post(e, "first password"));
    expect(t.get(e, "/", { cookie })).toBeNull();
    e.password = await own("second password");
    expect((await t.get(e, "/", { cookie }))?.status).toBe(401);
    const other = entry(e.password, { previewId: "01OTHER000000000000000000A" });
    expect((await t.get(other, "/", { cookie }))?.status).toBe(401);
  });

  test("the cookie expires", async () => {
    const t = makeGate();
    const e = entry(await own());
    const cookie = t.cookieOf(await t.post(e, "correct horse"));
    t.tick(7 * 86_400_000 + 1);
    expect((await t.get(e, "/", { cookie }))?.status).toBe(401);
  });

  test("inherit follows the shared password; none ignores it", async () => {
    const t = makeGate({ shared: await passwords.hash("shared secret") });
    expect((await t.get(entry({ mode: "inherit" })))?.status).toBe(401);
    expect(t.get(entry({ mode: "none" }))).toBeNull();
    expect((await t.post(entry({ mode: "inherit" }), "shared secret")).status).toBe(303);
  });

  test("a POST from another site is refused before the password is tried", async () => {
    const t = makeGate();
    const e = entry(await own());
    expect((await t.post(e, "correct horse", "/", { origin: "https://evil.example" })).status).toBe(
      403,
    );
    expect(t.failures).toEqual([]);
  });

  test.each(["https://evil.example/", "//evil.example/"])(
    "the form sends %s back to / on the same preview",
    async (to) => {
      const t = makeGate();
      const e = entry(await own());
      expect((await t.post(e, "correct horse", to)).headers.get("location")).toBe("/");
    },
  );

  test("guessing is throttled", async () => {
    const t = makeGate({ limiter: new LoginLimiter({ ipMax: 3 }) });
    const e = entry(await own());
    for (let i = 0; i < 3; i++) expect((await t.post(e, `guess ${i}`)).status).toBe(401);
    const res = await t.post(e, "correct horse");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).not.toBeNull();
  });

  test("an open preview has no password endpoint to guess at", async () => {
    const t = makeGate();
    expect((await t.post(entry({ mode: "none" }), "anything")).status).toBe(404);
  });

  test("a private preview asks for the login first, then the password", async () => {
    const t = makeGate();
    const res = (await t.get(entry(await own(), { visibility: "private" })))!;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/v1/auth/gate");
  });
});

describe("generated passwords", () => {
  test("four groups of four, no look-alike characters", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = generatePassword();
      expect(p).toMatch(/^[a-hjkmnp-z2-9]{4}(-[a-hjkmnp-z2-9]{4}){3}$/);
      seen.add(p);
    }
    expect(seen.size).toBe(200);
  });
});
