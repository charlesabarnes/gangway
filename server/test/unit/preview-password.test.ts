/**
 * ADR-0023: password-protected previews. The gate (a form served by gangway, a cookie bound
 * to the password), the deploy path (inherit / none / set / generate, the generated one only
 * in the log), a running preview's change, and the server-wide default's own route.
 */
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { AppEnv } from "../../src/app/env.ts";
import { errorHandler } from "../../src/app/problem.ts";
import { previewRoutes } from "../../src/app/routes/previews.ts";
import { settingsRoutes } from "../../src/app/routes/settings.ts";
import type { Actor } from "../../src/auth/actor.ts";
import { LoginLimiter } from "../../src/auth/limiter.ts";
import { Passwords } from "../../src/auth/password.ts";
import { Logger } from "../../src/logger.ts";
import { PASSWORD_COOKIE, PreviewGate, stripGangwayCookies } from "../../src/net/gate.ts";
import { deploy } from "../../src/previews/deploy.ts";
import { generatePassword, previewAccess } from "../../src/previews/password.ts";
import type { DefaultPasswordMode } from "../../../shared/src/domain.ts";
import type { EntryPassword, RouteEntry } from "../../src/routing/table.ts";
import { MemorySettingsStore, SETTINGS, Settings } from "../../src/settings.ts";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";

const passwords = new Passwords({ ln: 10 });
const HOST = "shop.preview.example.dev";

const entry = (password: EntryPassword, over: Partial<RouteEntry> = {}): RouteEntry => ({
  hostname: HOST,
  previewId: "01SHOP0000000000000000000A",
  hostId: "local",
  project: "gw-shop",
  service: "web",
  containerPort: 80,
  upstreamHost: "127.0.0.1",
  upstreamPort: 31000,
  primary: true,
  visibility: "public",
  password,
  passwordLogin: "off",
  state: "awake",
  inflight: 0,
  bytesInFlight: 0,
  lastSeenAt: 0,
  ...over,
});

async function makeGate(
  o: { shared?: { hash: string; salt: string } | null; limiter?: LoginLimiter } = {},
) {
  let now = 1_700_000_000_000;
  const failures: string[] = [];
  const gate = new PreviewGate({
    key: randomBytes(32),
    appOrigin: () => "https://app.preview.example.dev",
    now: () => now,
    sharedPassword: () => o.shared ?? null,
    passwords,
    limiter: o.limiter ?? new LoginLimiter(),
    onPasswordFailure: (_e, _ip, reason) => failures.push(reason),
  });
  const get = (e: RouteEntry, path = "/", headers: Record<string, string> = {}) =>
    gate.handle(
      e,
      new Request(`https://${HOST}${path}`, {
        headers: { "sec-fetch-mode": "navigate", ...headers },
      }),
      "198.51.100.4",
    );
  const post = async (
    e: RouteEntry,
    password: string,
    to = "/",
    headers: Record<string, string> = {},
  ) =>
    gate.handle(
      e,
      new Request(`https://${HOST}/__gangway/password`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: `https://${HOST}`,
          ...headers,
        },
        body: new URLSearchParams({ password, to }).toString(),
      }),
      "198.51.100.4",
    )!;
  const cookieOf = (res: Response) => res.headers.get("set-cookie")?.split(";")[0] ?? "";
  return {
    gate,
    get,
    post,
    cookieOf,
    failures,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe("the password gate", () => {
  test("an open preview (none, or inherit with no shared password) passes straight through", async () => {
    const t = await makeGate();
    expect(t.get(entry({ mode: "none" }))).toBeNull();
    expect(t.get(entry({ mode: "inherit" }))).toBeNull();
  });

  test("a page load gets gangway's form, not the preview; a fetch gets a plain 401", async () => {
    const t = await makeGate();
    const own = await passwords.hash("correct horse");
    const res = (await t.get(entry({ mode: "own", ...own }), "/orders?x=1"))!;
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain('action="/__gangway/password"');
    expect(html).toContain('value="/orders?x=1"');
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const api = (await t.gate.handle(
      entry({ mode: "own", ...own }),
      new Request(`https://${HOST}/api`, { headers: { "sec-fetch-mode": "cors" } }),
    ))!;
    expect(api.status).toBe(401);
    expect(api.headers.get("content-type")).toContain("text/plain");
  });

  test("the right password sets a cookie that opens it; the wrong one does not", async () => {
    const t = await makeGate();
    const e = entry({ mode: "own", ...(await passwords.hash("correct horse")) });
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
    // The cookie never reaches the preview.
    expect(stripGangwayCookies(`a=1; ${t.cookieOf(right)}`)).toBe("a=1");
  });

  test("changing the password retires every cookie for the old one; so does another preview's id", async () => {
    const t = await makeGate();
    const e = entry({ mode: "own", ...(await passwords.hash("first password")) });
    const cookie = t.cookieOf(await t.post(e, "first password"));
    expect(t.get(e, "/", { cookie })).toBeNull();
    e.password = { mode: "own", ...(await passwords.hash("second password")) };
    expect((await t.get(e, "/", { cookie }))?.status).toBe(401);
    const other = entry(e.password, { previewId: "01OTHER000000000000000000A" });
    expect((await t.get(other, "/", { cookie }))?.status).toBe(401);
  });

  test("the cookie expires", async () => {
    const t = await makeGate();
    const e = entry({ mode: "own", ...(await passwords.hash("correct horse")) });
    const cookie = t.cookieOf(await t.post(e, "correct horse"));
    t.tick(7 * 86_400_000 + 1);
    expect((await t.get(e, "/", { cookie }))?.status).toBe(401);
  });

  test("inherit follows the shared password; none ignores it", async () => {
    const t = await makeGate({ shared: await passwords.hash("shared secret") });
    expect((await t.get(entry({ mode: "inherit" })))?.status).toBe(401);
    expect(t.get(entry({ mode: "none" }))).toBeNull();
    expect((await t.post(entry({ mode: "inherit" }), "shared secret")).status).toBe(303);
  });

  test("a POST from another site is refused before the password is tried", async () => {
    const t = await makeGate();
    const e = entry({ mode: "own", ...(await passwords.hash("correct horse")) });
    expect((await t.post(e, "correct horse", "/", { origin: "https://evil.example" })).status).toBe(
      403,
    );
    expect(t.failures).toEqual([]);
  });

  test("the form only redirects to a path on the same preview", async () => {
    const t = await makeGate();
    const e = entry({ mode: "own", ...(await passwords.hash("correct horse")) });
    expect(
      (await t.post(e, "correct horse", "https://evil.example/")).headers.get("location"),
    ).toBe("/");
    expect((await t.post(e, "correct horse", "//evil.example/")).headers.get("location")).toBe("/");
  });

  test("guessing is throttled", async () => {
    const t = await makeGate({ limiter: new LoginLimiter({ ipMax: 3 }) });
    const e = entry({ mode: "own", ...(await passwords.hash("correct horse")) });
    for (let i = 0; i < 3; i++) expect((await t.post(e, `guess ${i}`)).status).toBe(401);
    const res = await t.post(e, "correct horse");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).not.toBeNull();
  });

  test("an open preview has no password endpoint to guess at", async () => {
    const t = await makeGate();
    expect((await t.post(entry({ mode: "none" }), "anything")).status).toBe(404);
  });

  test("a private preview asks for the login first, then the password", async () => {
    const t = await makeGate();
    const e = entry(
      { mode: "own", ...(await passwords.hash("correct horse")) },
      { visibility: "private" },
    );
    const res = (await t.get(e))!;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/v1/auth/gate");
  });
});

describe("signed in instead of the password", () => {
  async function gateWith(loginDefault = true) {
    const gate = new PreviewGate({
      key: randomBytes(32),
      appOrigin: () => "https://app.preview.example.dev",
      passwords,
      loginDefault: () => loginDefault,
    });
    const own = await passwords.hash("pw");
    const get = (e: RouteEntry, path = "/", cookie?: string) =>
      gate.handle(
        e,
        new Request(`https://${HOST}${path}`, {
          headers: { "sec-fetch-mode": "navigate", ...(cookie ? { cookie } : {}) },
        }),
      ) as Response | null;
    const signIn = (e: RouteEntry, skipPassword: boolean) =>
      get(
        e,
        `/__gangway/auth?ticket=${encodeURIComponent(gate.issueTicket(e, { skipPassword }))}&to=/`,
      )!
        .headers.get("set-cookie")!
        .split(";")[0]!;
    return { gate, own, get, signIn };
  }

  test("login on: a page load with no cookie bounces through app once, not to the form", async () => {
    const t = await gateWith();
    const res = t.get(entry({ mode: "own", ...t.own }, { passwordLogin: "on" }), "/x")!;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `https://app.preview.example.dev/v1/auth/gate?host=${HOST}&to=%2Fx`,
    );
  });

  test("login off, or inherit with the switch off: the form, no bounce", async () => {
    expect(
      (await gateWith()).get(
        entry({ mode: "own", ...(await passwords.hash("pw")) }, { passwordLogin: "off" }),
      )!.status,
    ).toBe(401);
    const t = await gateWith(false);
    expect(t.get(entry({ mode: "own", ...t.own }, { passwordLogin: "inherit" }))!.status).toBe(401);
    expect(t.gate.gateable(entry({ mode: "own", ...t.own }, { passwordLogin: "inherit" }))).toEqual(
      { private: false, passwordSkippable: false },
    );
  });

  test("app sends a stranger back to /__gangway/password, which is the form for where they were going", async () => {
    const t = await gateWith();
    const res = t.get(
      entry({ mode: "own", ...t.own }, { passwordLogin: "on" }),
      "/__gangway/password?to=%2Forders",
    )!;
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('name="to" value="/orders"');
  });

  test("a ticket that may skip opens it; one that may not earns a cookie that still gets the form, with no second bounce", async () => {
    const t = await gateWith();
    const e = entry({ mode: "own", ...t.own }, { passwordLogin: "on" });
    expect(t.get(e, "/", t.signIn(e, true))).toBeNull();
    const plain = t.signIn(e, false);
    expect(t.get(e, "/", plain)!.status).toBe(401);
  });

  test("turning the login off takes effect on a skip cookie already handed out", async () => {
    const t = await gateWith();
    const e = entry({ mode: "own", ...t.own }, { passwordLogin: "on" });
    const cookie = t.signIn(e, true);
    e.passwordLogin = "off";
    expect(t.get(e, "/", cookie)!.status).toBe(401);
    // ...and no ticket is redeemed for it either.
    expect(
      t.get(
        e,
        `/__gangway/auth?ticket=${encodeURIComponent(t.gate.issueTicket(e, { skipPassword: true }))}&to=/`,
      )!.status,
    ).toBe(404);
  });

  test("private and password: the private sign-in may carry the skip, so there is one handshake, not two", async () => {
    const t = await gateWith();
    const e = entry({ mode: "own", ...t.own }, { passwordLogin: "on", visibility: "private" });
    expect(t.get(e)!.status).toBe(302);
    expect(t.get(e, "/", t.signIn(e, true))).toBeNull();
    expect(t.get(e, "/", t.signIn(e, false))!.status).toBe(401);
  });

  test("a gate cookie from before ADR-0023 still opens a private preview, and never skips a password", async () => {
    const key = randomBytes(32);
    const { createHmac } = await import("node:crypto");
    const payload = `01SHOP0000000000000000000A.${Date.now() + 60_000}`;
    const old = `__Host-gw_pv=${payload}.${createHmac("sha256", key).update(`cookie|${payload}`).digest("base64url")}`;
    const gate = new PreviewGate({
      key,
      appOrigin: () => "https://app.preview.example.dev",
      passwords,
    });
    const req = () =>
      new Request(`https://${HOST}/`, { headers: { cookie: old, "sec-fetch-mode": "navigate" } });
    expect(gate.check(entry({ mode: "none" }, { visibility: "private" }), req())).toBeNull();
    expect(
      gate.check(
        entry(
          { mode: "own", ...(await passwords.hash("pw")) },
          { visibility: "private", passwordLogin: "on" },
        ),
        req(),
      )!.status,
    ).toBe(401);
  });
});

describe("who can open it, as the UI is told", () => {
  const deps = (o: { mode?: DefaultPasswordMode; shared?: boolean; login?: boolean } = {}) => ({
    passwords,
    defaultMode: () => o.mode ?? "off",
    sharedSet: () => o.shared ?? false,
    loginDefault: () => o.login ?? false,
  });
  const pub = { visibility: "unlisted" as const };
  test("a password of its own means the password, for everyone, unless the login rule says either", () => {
    expect(previewAccess(deps(), { ...pub, password: "set", passwordLogin: "inherit" })).toBe(
      "password",
    );
    expect(
      previewAccess(deps({ login: true }), {
        ...pub,
        password: "generated",
        passwordLogin: "inherit",
      }),
    ).toBe("either");
    expect(
      previewAccess(deps({ login: true }), { ...pub, password: "set", passwordLogin: "off" }),
    ).toBe("password");
    expect(previewAccess(deps(), { ...pub, password: "set", passwordLogin: "on" })).toBe("either");
  });
  test("only: signed-in people, whatever the password", () => {
    expect(previewAccess(deps(), { ...pub, password: "set", passwordLogin: "only" })).toBe(
      "signed-in",
    );
    expect(previewAccess(deps(), { ...pub, password: "none", passwordLogin: "only" })).toBe(
      "signed-in",
    );
  });
  test("inherit is a password only while the default is shared AND one is set; none is open", () => {
    expect(
      previewAccess(deps({ mode: "shared", shared: true }), {
        ...pub,
        password: "inherit",
        passwordLogin: "inherit",
      }),
    ).toBe("password");
    expect(
      previewAccess(deps({ mode: "shared", shared: false }), {
        ...pub,
        password: "inherit",
        passwordLogin: "inherit",
      }),
    ).toBe("open");
    expect(
      previewAccess(deps({ mode: "generated", shared: true }), {
        ...pub,
        password: "inherit",
        passwordLogin: "inherit",
      }),
    ).toBe("open");
    expect(
      previewAccess(deps({ mode: "shared", shared: true }), {
        ...pub,
        password: "none",
        passwordLogin: "on",
      }),
    ).toBe("open");
  });
  test("private visibility is signed-in, plus the password unless a login skips it", () => {
    expect(
      previewAccess(deps(), { visibility: "private", password: "none", passwordLogin: "inherit" }),
    ).toBe("signed-in");
    expect(
      previewAccess(deps(), { visibility: "private", password: "set", passwordLogin: "off" }),
    ).toBe("signed-in+password");
    expect(
      previewAccess(deps(), { visibility: "private", password: "set", passwordLogin: "on" }),
    ).toBe("signed-in");
  });
});

describe("only people signed in to gangway (passwordLogin only)", () => {
  test("the gate treats it as private: a bounce to app to log in, never the password form, and the password does not open it", async () => {
    const gate = new PreviewGate({
      key: randomBytes(32),
      appOrigin: () => "https://app.preview.example.dev",
      passwords,
    });
    const e = entry({ mode: "own", ...(await passwords.hash("pw")) }, { passwordLogin: "only" });
    const res = gate.handle(
      e,
      new Request(`https://${HOST}/x`, { headers: { "sec-fetch-mode": "navigate" } }),
    ) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/v1/auth/gate");
    expect(gate.gateable(e)).toEqual({ private: true, passwordSkippable: false });
    const post = await gate.handle(
      e,
      new Request(`https://${HOST}/__gangway/password`, {
        method: "POST",
        headers: { origin: `https://${HOST}`, "content-type": "application/x-www-form-urlencoded" },
        body: "password=pw&to=/",
      }),
    );
    expect(post!.status).toBe(404);
    const cookie = gate.handle(
      e,
      new Request(
        `https://${HOST}/__gangway/auth?ticket=${encodeURIComponent(gate.issueTicket(e))}&to=/`,
      ),
    ) as Response;
    expect(
      gate.check(
        e,
        new Request(`https://${HOST}/`, {
          headers: { cookie: cookie.headers.get("set-cookie")!.split(";")[0]! },
        }),
      ),
    ).toBeNull();
  });

  test("stored in its own column: switching away and back keeps the password and the earlier rule", async () => {
    const t = withPasswords();
    const { preview, done } = await deploy(t.ctx, {
      actor: ACTOR,
      name: "only",
      visibility: "public",
      source: t.image,
      password: { mode: "set", value: "pw" },
      passwordLogin: "only",
    });
    await done;
    expect(preview.passwordLogin).toBe("only");
    expect(t.table.forPreview(preview.id)[0]!.passwordLogin).toBe("only");
    t.previews.setPasswordLogin(preview.id, "on");
    expect(t.previews.get(preview.id)!.passwordLogin).toBe("on");
    t.previews.setPasswordLogin(preview.id, "only");
    t.previews.setPasswordLogin(preview.id, "off");
    expect(t.previews.get(preview.id)!.passwordLogin).toBe("off");
    expect(t.previews.passwordOf(preview.id).mode).toBe("set");
  });

  test("refused with the web UI off: there would be no login page", async () => {
    const t = withPasswords();
    t.ctx.privateAvailable = () => false;
    const p = await t.deployed("x");
    const { setPreviewPassword } = await import("../../src/previews/password.ts");
    await expect(
      setPreviewPassword(t.ctx, { actor: ACTOR, previewId: p.id, login: "only" }),
    ).rejects.toThrow(/web UI/);
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

function withPasswords(defaultMode: DefaultPasswordMode = "off") {
  const s = setupPreviewContext();
  const mode = { value: defaultMode };
  s.ctx.passwords = { passwords, defaultMode: () => mode.value };
  const image = { kind: "image" as const, image: "traefik/whoami:v1.10", port: 80 };
  return { ...s, mode, image };
}

describe("deploying with a password", () => {
  test("omitted: inherit, and the route entry says so", async () => {
    const t = withPasswords();
    const { preview, done } = await deploy(t.ctx, {
      actor: ACTOR,
      name: "plain",
      visibility: "public",
      source: t.image,
    });
    await done;
    expect(preview.password).toBe("inherit");
    expect(t.table.forPreview(preview.id)[0]!.password).toEqual({ mode: "inherit" });
  });

  test("set: hashed, never stored or logged as text", async () => {
    const t = withPasswords();
    const { preview, done } = await deploy(t.ctx, {
      actor: ACTOR,
      name: "set",
      visibility: "public",
      source: t.image,
      password: { mode: "set", value: "my own password" },
    });
    await done;
    expect(preview.password).toBe("set");
    const stored = t.previews.passwordOf(preview.id);
    expect(stored.mode).toBe("set");
    expect(await passwords.verify("my own password", stored.secret!)).toBe(true);
    expect(t.table.forPreview(preview.id)[0]!.password).toMatchObject({
      mode: "own",
      hash: stored.secret!.hash,
    });
    expect(t.ctx.logs.tail(preview.id, 500).join("\n")).not.toContain("my own password");
    const dump = JSON.stringify(t.db.query("SELECT * FROM audit"));
    expect(dump).not.toContain("my own password");
  });

  test("generate: the password is in the preview's log, once, and verifies against the stored hash", async () => {
    const t = withPasswords();
    const { preview, done } = await deploy(t.ctx, {
      actor: ACTOR,
      name: "gen",
      visibility: "public",
      source: t.image,
      password: { mode: "generate" },
    });
    await done;
    expect(preview.password).toBe("generated");
    const lines = t.ctx.logs.tail(preview.id, 500).filter((l) => l.includes("preview password"));
    expect(lines).toHaveLength(1);
    const plain = /: ([a-z0-9-]{19})$/.exec(lines[0]!)![1]!;
    expect(await passwords.verify(plain, t.previews.passwordOf(preview.id).secret!)).toBe(true);
    expect(JSON.stringify(t.db.query("SELECT * FROM previews"))).not.toContain(plain);
    expect(JSON.stringify(t.db.query("SELECT * FROM events"))).not.toContain(plain);
  });

  test("inherit while the default is `generated` gives the new preview its own", async () => {
    const t = withPasswords("generated");
    const { preview, done } = await deploy(t.ctx, {
      actor: ACTOR,
      name: "auto",
      visibility: "public",
      source: t.image,
    });
    await done;
    expect(preview.password).toBe("generated");
    expect(
      t.ctx.logs.tail(preview.id, 500).some((l) => l.includes("preview password (generated")),
    ).toBe(true);
  });

  test("none opens it whatever the default", async () => {
    const t = withPasswords("generated");
    const { preview, done } = await deploy(t.ctx, {
      actor: ACTOR,
      name: "open",
      visibility: "public",
      source: t.image,
      password: { mode: "none" },
    });
    await done;
    expect(preview.password).toBe("none");
    expect(t.table.forPreview(preview.id)[0]!.password).toEqual({ mode: "none" });
  });

  test("without a hasher, only inherit and none work", async () => {
    const t = setupPreviewContext();
    await expect(
      deploy(t.ctx, {
        actor: ACTOR,
        name: "x",
        visibility: "public",
        source: { kind: "image", image: "a", port: 80 },
        password: { mode: "generate" },
      }),
    ).rejects.toThrow(/not available/);
  });
});

describe("PUT /v1/previews/:id/password", () => {
  function make(actor: Actor = ACTOR) {
    const t = withPasswords();
    const api = new Hono<AppEnv>();
    api.onError(errorHandler(new Logger("error", {}, () => {})));
    api.use(async (c, next) => {
      c.set("requestId", "r");
      c.set("actor", actor);
      return next();
    });
    previewRoutes(api, t.ctx, null as never);
    const put = (id: string, body: unknown) =>
      api.request(`/previews/${id}/password`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    return { ...t, put };
  }

  test("set, generate, open again -- each takes effect on the route at once and is audited by mode only", async () => {
    const t = make();
    const p = await t.deployed("live");
    let res = await t.put(p.id, { password: { mode: "set", value: "brand new password" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { preview: { password: string } }).preview.password).toBe("set");
    expect(t.table.forPreview(p.id)[0]!.password.mode).toBe("own");

    res = await t.put(p.id, { password: { mode: "generate" } });
    expect(((await res.json()) as { preview: { password: string } }).preview.password).toBe(
      "generated",
    );
    const lines = t.ctx.logs
      .tail(p.id, 500)
      .filter((l) => l.includes("preview password (generated"));
    expect(lines).toHaveLength(1);
    const plain = /: ([a-z0-9-]{19})$/.exec(lines[0]!)![1]!;
    expect(JSON.stringify(t.previews.get(p.id))).not.toContain(plain);

    res = await t.put(p.id, { password: { mode: "none" } });
    expect(t.table.forPreview(p.id)[0]!.password).toEqual({ mode: "none" });
    const audit = t.db.query<{ action: string; new_json: string }>(
      "SELECT action, new_json FROM audit WHERE action = 'preview.password' ORDER BY seq",
    );
    expect(audit.map((a) => JSON.parse(a.new_json).mode)).toEqual(["set", "generated", "none"]);
    expect(JSON.stringify(audit)).not.toContain("brand new password");
  });

  test("any length but empty; someone else's preview needs previews.update", async () => {
    const t = make();
    const p = await t.deployed("mine");
    expect((await t.put(p.id, { password: { mode: "set", value: "" } })).status).toBe(422);
    expect((await t.put(p.id, { password: { mode: "set", value: "a" } })).status).toBe(200);

    const member: Actor = {
      kind: "user",
      userId: "u-bob",
      roleId: "member",
      permissions: new Set(["previews.update_own"]),
      sessionId: "s",
    };
    const other = make(member);
    const q = await other.deployed("theirs");
    expect((await other.put(q.id, { password: { mode: "none" } })).status).toBe(403);
  });
});

describe("PUT /v1/settings/preview-password", () => {
  function make() {
    const settings = new Settings({}, new MemorySettingsStore());
    const records: unknown[] = [];
    const api = new Hono<AppEnv>();
    api.onError(errorHandler(new Logger("error", {}, () => {})));
    api.use(async (c, next) => {
      c.set("requestId", "r");
      c.set("actor", ACTOR);
      return next();
    });
    settingsRoutes(
      api,
      settings,
      {
        record: (...a: unknown[]) => {
          records.push(a);
        },
      } as never,
      undefined,
      (p) => passwords.hash(p),
    );
    const put = (path: string, body: unknown) =>
      api.request(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    return { settings, put, records };
  }

  test("shared: hashed into a secret setting, reported as set, never as a value", async () => {
    const t = make();
    const res = await t.put("/settings/preview-password", {
      mode: "shared",
      value: "team password",
    });
    expect(res.status).toBe(200);
    const view = (
      (await res.json()) as { settings: { key: string; value: unknown; set: boolean }[] }
    ).settings;
    expect(view.find((v) => v.key === "previews.password.mode")?.value).toBe("shared");
    expect(view.find((v) => v.key === "previews.password.shared")).toMatchObject({
      value: null,
      set: true,
    });
    expect(
      await passwords.verify("team password", t.settings.get(SETTINGS.previewPasswordShared)!),
    ).toBe(true);
    expect(JSON.stringify(t.records)).not.toContain("team password");
  });

  test("shared needs a value the first time, and keeps the old one after", async () => {
    const t = make();
    expect((await t.put("/settings/preview-password", { mode: "shared" })).status).toBe(422);
    await t.put("/settings/preview-password", { mode: "shared", value: "team password" });
    await t.put("/settings/preview-password", { mode: "off" });
    expect((await t.put("/settings/preview-password", { mode: "shared" })).status).toBe(200);
    expect(
      await passwords.verify("team password", t.settings.get(SETTINGS.previewPasswordShared)!),
    ).toBe(true);
  });

  test("a value with any other mode is refused; the generic PUT cannot write these keys", async () => {
    const t = make();
    expect(
      (await t.put("/settings/preview-password", { mode: "generated", value: "team password" }))
        .status,
    ).toBe(422);
    expect(
      (
        await t.put("/settings", {
          values: { "previews.password.shared": { hash: "x", salt: "y" } },
        })
      ).status,
    ).toBe(409);
    expect(
      (await t.put("/settings", { values: { "previews.password.mode": "shared" } })).status,
    ).toBe(409);
    expect((await t.put("/settings/preview-password", { mode: "generated" })).status).toBe(200);
    expect(t.settings.get(SETTINGS.previewPasswordMode)).toBe("generated");
  });
});
