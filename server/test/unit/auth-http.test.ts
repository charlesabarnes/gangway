import { describe, expect, test } from "bun:test";
import { createApp, surfaceHandler } from "../../src/app/app.ts";
import { requirePermission } from "../../src/app/middleware/auth.ts";
import { authRoutes } from "../../src/app/routes/auth.ts";
import { actorId, staticTokenVerifier } from "../../src/auth/actor.ts";
import { Bootstrap } from "../../src/auth/bootstrap.ts";
import { PASSWORD, setupAccounts } from "../helpers/accounts.ts";
import { silentLogger } from "../helpers/logger.ts";

const TOKEN = "gw_http_test_admin_token_0123456789";
const APP = "https://app.preview.localhost:8443";
const SIBLING = "https://evil-preview.preview.localhost:8443";

function make() {
  const s = setupAccounts();
  const bootstrap = new Bootstrap(() => s.users.count());
  const auth = {
    verifyToken: staticTokenVerifier(TOKEN),
    resolveSession: (secret: string) => s.sessions.resolve(secret)?.actor ?? null,
    originFor: (host: string) => `https://${host}`,
  };
  const app = createApp({
    ...auth,
    logger: silentLogger(),
    v1: (api) => {
      api.get("/whoami", requirePermission("previews.read"), (c) =>
        c.json({ id: actorId(c.get("actor")) }),
      );
      api.post("/mutate", requirePermission("previews.deploy"), (c) => c.json({ ok: true }));
    },
    publicV1: (pub) =>
      authRoutes(pub, {
        auth,
        accounts: s.accounts,
        bootstrap,
        roles: s.roles,
        sessionMaxAgeSec: 2_592_000,
      }),
  });
  const on = (surface: "app" | "api") => {
    const h = surfaceHandler(app, surface);
    const host = `${surface}.preview.localhost:8443`;
    return (path: string, init: RequestInit & { json?: unknown } = {}) => {
      const headers = new Headers(init.headers);
      headers.set("host", host);
      if (init.json !== undefined) headers.set("content-type", "application/json");
      return Promise.resolve(
        h(
          new Request(`https://${host}${path}`, {
            ...init,
            headers,
            ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
          }),
          { clientIp: "203.0.113.7" },
        ),
      );
    };
  };
  const setupToken = () => new URL(bootstrap.url(APP)!).searchParams.get("token")!;
  const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0]!;
  return { s, bootstrap, app: on("app"), api: on("api"), setupToken, cookieOf };
}

async function loggedIn() {
  const t = make();
  const res = await t.app("/v1/auth/setup", {
    method: "POST",
    json: { token: t.setupToken(), email: "ada@example.com", password: PASSWORD },
  });
  return { ...t, cookie: t.cookieOf(res), setupRes: res };
}

describe("first-run setup over HTTP", () => {
  test("session says setupRequired until the first admin exists; setup logs them in", async () => {
    const t = make();
    expect(await (await t.app("/v1/auth/session")).json()).toEqual({
      authenticated: false,
      setupRequired: true,
    });

    const res = await t.app("/v1/auth/setup", {
      method: "POST",
      json: { token: t.setupToken(), email: "  Ada@Example.com ", password: PASSWORD },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      user: { email: "ada@example.com", role: { id: "admin", name: "admin" } },
    });

    const me = (await (
      await t.app("/v1/auth/session", { headers: { cookie: t.cookieOf(res) } })
    ).json()) as { permissions: string[] };
    expect(me).toMatchObject({
      authenticated: true,
      setupRequired: false,
      user: { email: "ada@example.com" },
    });
    expect(me.permissions).toContain("users.manage");
  });

  test("the cookie is __Host-, HttpOnly, Secure, SameSite=Lax, Path=/, with no Domain", async () => {
    const { setupRes } = await loggedIn();
    expect(setupRes.headers.get("set-cookie")).toMatch(
      /^__Host-gw_session=[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
    );
  });

  test("neither a wrong link (403) nor a weak password (422) burns the link", async () => {
    const t = make();
    const setup = async (token: string, password: string) =>
      (
        await t.app("/v1/auth/setup", {
          method: "POST",
          json: { token, email: "a@example.com", password },
        })
      ).status;
    expect(await setup("gw_setup_nope", PASSWORD)).toBe(403);
    expect(await setup(t.setupToken(), "short")).toBe(422);
    expect(await setup(t.setupToken(), PASSWORD)).toBe(201);
  });

  test("once an admin exists, setup is a 404, even with the right link", async () => {
    const t = make();
    const token = t.setupToken();
    await t.app("/v1/auth/setup", {
      method: "POST",
      json: { token, email: "ada@example.com", password: PASSWORD },
    });
    expect(
      (
        await t.app("/v1/auth/setup", {
          method: "POST",
          json: { token, email: "eve@example.com", password: PASSWORD },
        })
      ).status,
    ).toBe(404);
    expect(t.s.users.count()).toBe(1);
  });

  test("setup and login exist only on the app hostname, where the cookie lives", async () => {
    const t = make();
    expect(
      (
        await t.api("/v1/auth/setup", {
          method: "POST",
          json: { token: t.setupToken(), email: "a@example.com", password: PASSWORD },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await t.api("/v1/auth/login", {
          method: "POST",
          json: { email: "a@example.com", password: PASSWORD },
        })
      ).status,
    ).toBe(404);
  });
});

describe("login over HTTP", () => {
  test("the right password sets a cookie; a wrong one gets the unknown-email 401", async () => {
    const t = await loggedIn();
    const ok = await t.app("/v1/auth/login", {
      method: "POST",
      json: { email: "ada@example.com", password: PASSWORD },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toStartWith("__Host-gw_session=");
    expect(ok.headers.get("cache-control")).toBe("no-store");

    const wrong = await t.app("/v1/auth/login", {
      method: "POST",
      json: { email: "ada@example.com", password: "not the password!" },
    });
    const unknown = await t.app("/v1/auth/login", {
      method: "POST",
      json: { email: "nobody@example.com", password: PASSWORD },
    });
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    const strip = (b: Record<string, unknown>) => ({ ...b, requestId: null });
    expect(strip((await wrong.json()) as Record<string, unknown>)).toEqual(
      strip((await unknown.json()) as Record<string, unknown>),
    );
  });

  test("lockout reaches the client as 429 with Retry-After", async () => {
    const t = await loggedIn();
    for (let i = 0; i < 5; i++)
      await t.app("/v1/auth/login", {
        method: "POST",
        json: { email: "ada@example.com", password: "wrong wrong wrong" },
      });
    const res = await t.app("/v1/auth/login", {
      method: "POST",
      json: { email: "ada@example.com", password: PASSWORD },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(res.headers.get("content-type")).toBe("application/problem+json");
  });

  test("login CSRF: a sibling preview cannot log your browser into its account", async () => {
    const t = await loggedIn();
    const body = { email: "ada@example.com", password: PASSWORD };
    expect(
      (await t.app("/v1/auth/login", { method: "POST", json: body, headers: { origin: SIBLING } }))
        .status,
    ).toBe(403);
    expect(
      (await t.app("/v1/auth/login", { method: "POST", json: body, headers: { origin: APP } }))
        .status,
    ).toBe(200);
    expect((await t.app("/v1/auth/login", { method: "POST", json: body })).status).toBe(200); // curl sends no Origin
  });

  test("a non-JSON body is a 400, not a 500", async () => {
    const t = make();
    expect(
      (
        await t.app("/v1/auth/login", {
          method: "POST",
          body: "email=a",
          headers: { "content-type": "text/plain" },
        })
      ).status,
    ).toBe(400);
  });
});

describe("the session cookie as a credential", () => {
  test("works for reads on app with no Origin, as EventSource sends them", async () => {
    const t = await loggedIn();
    const res = await t.app("/v1/whoami", { headers: { cookie: t.cookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toStartWith("user:");
  });

  test("is ignored on the api hostname, where it was never set", async () => {
    const t = await loggedIn();
    expect((await t.api("/v1/whoami", { headers: { cookie: t.cookie } })).status).toBe(401);
  });

  test("a mutation needs our own Origin; missing, sibling and same-site are refused", async () => {
    const t = await loggedIn();
    const post = (headers: Record<string, string>) =>
      t.app("/v1/mutate", { method: "POST", headers: { cookie: t.cookie, ...headers } });
    expect((await post({})).status).toBe(403);
    expect((await post({ origin: SIBLING })).status).toBe(403);
    expect((await post({ origin: "null" })).status).toBe(403);
    expect((await post({ origin: APP, "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await post({ origin: APP })).status).toBe(200);
    expect((await post({ origin: APP, "sec-fetch-site": "same-origin" })).status).toBe(200);
  });

  test("the refusal is a 403, not a 401: the credential was fine, the request was not", async () => {
    const t = await loggedIn();
    const res = await t.app("/v1/mutate", {
      method: "POST",
      headers: { cookie: t.cookie, origin: SIBLING },
    });
    expect(await res.json()).toMatchObject({ status: 403, detail: "cross-origin request refused" });
  });

  test("a bearer token needs no Origin, and beats a cookie sent alongside it", async () => {
    const t = await loggedIn();
    expect(
      (await t.api("/v1/mutate", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }))
        .status,
    ).toBe(200);
    const both = await t.app("/v1/whoami", {
      headers: { authorization: `Bearer ${TOKEN}`, cookie: t.cookie },
    });
    expect(await both.json()).toEqual({ id: "env:admin" });
  });

  test("a wrong bearer never falls through to a valid cookie", async () => {
    const t = await loggedIn();
    expect(
      (
        await t.app("/v1/whoami", {
          headers: { authorization: "Bearer gw_wrong_token_0123456789abcdef", cookie: t.cookie },
        })
      ).status,
    ).toBe(401);
  });

  test("a forged or garbage cookie is just unauthenticated", async () => {
    const t = await loggedIn();
    for (const cookie of [
      "__Host-gw_session=",
      "__Host-gw_session=nope",
      `__Host-gw_session=${"A".repeat(43)}`,
      `gw_session=${t.cookie.split("=")[1]}`,
    ]) {
      expect((await t.app("/v1/whoami", { headers: { cookie } })).status).toBe(401);
    }
  });

  test("an unknown /v1 path is 401 before 404, even under the public auth mount", async () => {
    const t = await loggedIn();
    expect((await t.app("/v1/does-not-exist")).status).toBe(401);
    expect((await t.app("/v1/auth/does-not-exist")).status).toBe(401);
    expect((await t.app("/v1/does-not-exist", { headers: { cookie: t.cookie } })).status).toBe(404);
  });
});

describe("logout and changing a password", () => {
  test("logout ends the session server-side, clears the cookie, and is idempotent", async () => {
    const t = await loggedIn();
    const res = await t.app("/v1/auth/logout", {
      method: "POST",
      headers: { cookie: t.cookie, origin: APP },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toMatch(
      /^__Host-gw_session=; Max-Age=0; Path=\/; Secure$/,
    );
    expect((await t.app("/v1/whoami", { headers: { cookie: t.cookie } })).status).toBe(401);
    expect(
      (
        await t.app("/v1/auth/logout", {
          method: "POST",
          headers: { cookie: t.cookie, origin: APP },
        })
      ).status,
    ).toBe(204);
  });

  test("a sibling preview cannot log you out", async () => {
    const t = await loggedIn();
    expect(
      (
        await t.app("/v1/auth/logout", {
          method: "POST",
          headers: { cookie: t.cookie, origin: SIBLING },
        })
      ).status,
    ).toBe(403);
    expect((await t.app("/v1/whoami", { headers: { cookie: t.cookie } })).status).toBe(200);
  });

  test("change password: needs a session, the current password, and our Origin", async () => {
    const t = await loggedIn();
    const body = { current: PASSWORD, next: "a brand new password" };
    const change = async (json: typeof body, headers: Record<string, string>) =>
      (await t.app("/v1/auth/password", { method: "POST", json, headers })).status;
    const mine = { cookie: t.cookie, origin: APP };
    expect(await change(body, {})).toBe(401);
    expect(await change(body, { cookie: t.cookie, origin: SIBLING })).toBe(403);
    expect(await change({ ...body, current: "not my password!" }, mine)).toBe(403);
    expect(await change({ ...body, next: "short" }, mine)).toBe(422);
    expect(await change(body, mine)).toBe(204);
    expect(
      (
        await t.app("/v1/auth/login", {
          method: "POST",
          json: { email: "ada@example.com", password: "a brand new password" },
        })
      ).status,
    ).toBe(200);
  });

  test("session describes a bearer token too, without pretending it is a person", async () => {
    const t = make();
    expect(
      await (
        await t.api("/v1/auth/session", { headers: { authorization: `Bearer ${TOKEN}` } })
      ).json(),
    ).toMatchObject({ authenticated: true, token: { id: "env:admin", scopes: ["admin"] } });
  });
});
