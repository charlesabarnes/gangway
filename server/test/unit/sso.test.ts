import { describe, expect, test } from "bun:test";
import { ADMIN_ROLE_ID } from "@gangway/shared/permissions";
import { HOME_ORG_ID } from "../../src/db/repos/orgs.ts";
import { PASSWORD } from "../helpers/accounts.ts";
import { APP, CLIENT, ISSUER, keyPair, make, SECRET, withBo } from "../helpers/sso.ts";
describe("sign-in through an OpenID Connect provider", () => {
  test("start sends the browser to the provider with PKCE, state and nonce", async () => {
    const t = make();
    const res = await t.req("/v1/auth/oidc/start");
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe(`${ISSUER}/authorize`);
    expect(Object.fromEntries(to.searchParams)).toMatchObject({
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: `${APP}/v1/auth/oidc/callback`,
      scope: "openid email profile",
      code_challenge_method: "S256",
    });
    expect(to.searchParams.get("state")).toMatch(/^[\w-]{43}$/);
    expect(to.searchParams.get("nonce")).toMatch(/^[\w-]{43}$/);
    expect(res.headers.get("set-cookie")).toMatch(
      /^__Host-gw_oidc=[\w-]{43}; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
    );
  });

  test("a known user is signed in and sent to next; the provider got client_secret_basic", async () => {
    const t = await withBo();
    const res = await t.signIn({ next: "/projects?x=1" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/projects?x=1");
    const cookie = t.sessionCookie(res);
    expect(cookie).toBeDefined();
    const me = (await (
      await t.req("/v1/auth/session", { headers: { cookie: cookie! } })
    ).json()) as {
      user?: { email: string };
    };
    expect(me.user?.email).toBe("bo@example.com");
    expect(t.p.state.basic).toBe(`Basic ${Buffer.from(`${CLIENT}:${SECRET}`).toString("base64")}`);
    expect(t.s.actions()).toContain("auth.login");
  });

  test("ES256 tokens verify too", async () => {
    const t = await withBo({ keys: [keyPair("ES256", "ec1")] });
    expect(t.sessionCookie(await t.signIn())).toBeDefined();
  });

  test("a next that leaves the origin is replaced by /", async () => {
    const t = await withBo();
    for (const next of [
      "//evil.example/x",
      "/\\evil.example",
      "https://evil.example",
      "/\t/evil.example",
    ]) {
      t.p.state.nonce = "";
      const res = await t.signIn({ next });
      expect(res.headers.get("location")).toBe("/");
    }
  });

  const refused = async (
    tweak: (t: Awaited<ReturnType<typeof withBo>>) => void,
    reason = "failed",
    o: Parameters<typeof make>[0] = {},
  ) => {
    const t = await withBo(o);
    tweak(t);
    const res = await t.signIn();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/login?sso=${reason}`);
    expect(t.sessionCookie(res)).toBeUndefined();
    return t;
  };

  test("a bad signature is refused", async () => {
    const other = keyPair("RS256", "k1");
    await refused((t) => {
      t.p.state.signer = other;
    });
  });

  test("another audience or issuer is refused", async () => {
    await refused((t) => {
      t.p.state.claims = { aud: "someone-else" };
    });
    await refused((t) => {
      t.p.state.claims = { iss: "https://evil.example" };
    });
    await refused((t) => {
      t.p.state.claims = { aud: [CLIENT, "other"], azp: "other" };
    });
  });

  test("an expired or not-yet-valid token is refused", async () => {
    await refused((t) => {
      t.p.state.claims = { exp: Math.floor(Date.now() / 1000) - 3600 };
    });
    await refused((t) => {
      t.p.state.claims = { nbf: Math.floor(Date.now() / 1000) + 3600 };
    });
  });

  test("starts are capped per source before any state is made", async () => {
    const t = make();
    const places = [];
    for (let n = 0; n < 21; n++) {
      places.push((await t.req("/v1/auth/oidc/start")).headers.get("location") ?? "");
    }
    const issuer = new URL(ISSUER).origin;
    expect(places.slice(0, 20).every((l) => new URL(l).origin === issuer)).toBe(true);
    expect(places[20]).toBe("/login?sso=rate-limited");
  });

  test("a nonce from another sign-in is refused", async () => {
    await refused((t) => {
      t.p.state.nonce = "not-the-nonce";
    });
  });

  test("an unverified email is refused", async () => {
    await refused((t) => {
      t.p.state.claims = { email_verified: false };
    });
  });

  test("a state unlike the cookie, or no cookie, never reaches the token endpoint", async () => {
    const t = await withBo();
    expect((await t.signIn({ tamperState: true })).headers.get("location")).toBe(
      "/login?sso=failed",
    );
    expect((await t.signIn({ noCookie: true })).headers.get("location")).toBe("/login?sso=failed");
    expect(t.p.state.tokenCalls).toBe(0);
  });

  test("someone with no account here is told so, and nothing is created", async () => {
    const t = await refused((t) => {
      t.p.state.claims = { email: "stranger@example.com", sub: "other" };
    }, "no-account");
    expect(t.s.users.getByEmail("stranger@example.com")).toBeUndefined();
    expect(t.s.actions()).toContain("auth.login.failed");
  });

  test("a disabled account is refused", async () => {
    const t = await withBo();
    const bo = t.s.users.getByEmail("bo@example.com")!;
    await t.req(`/v1/users/${bo.id}`, {
      method: "PATCH",
      headers: t.admin,
      json: { disabled: true },
    });
    expect((await t.signIn()).headers.get("location")).toBe("/login?sso=no-account");
  });

  test("later sign-ins match the provider's subject, even after an email change", async () => {
    const t = await withBo();
    expect(t.sessionCookie(await t.signIn())).toBeDefined();
    t.p.state.nonce = "";
    t.p.state.claims = { email: "bo.new@example.com" };
    const res = await t.signIn();
    expect(t.sessionCookie(res)).toBeDefined();
    expect(t.s.identities.userFor(ISSUER, "subject-1")).toBe(
      t.s.users.getByEmail("bo@example.com")!.id,
    );
  });

  test("an email match never takes an account linked to another subject there", async () => {
    const t = await withBo();
    expect(t.sessionCookie(await t.signIn())).toBeDefined();
    t.p.state.nonce = "";
    t.p.state.claims = { sub: "someone-else" };
    expect((await t.signIn()).headers.get("location")).toBe("/login?sso=no-account");
  });

  test("an invited account that signs in through the provider is no longer waiting", async () => {
    const t = make();
    const { user } = await t.s.admin();
    const actor = {
      kind: "user" as const,
      userId: user.id,
      roleId: user.roleId,
      permissions: new Set<never>(),
      sessionId: "s",
      orgId: HOME_ORG_ID,
    };
    await t.s.accounts.createUser(actor, { email: "bo@example.com", roleId: ADMIN_ROLE_ID });
    expect(t.s.users.getByEmail("bo@example.com")!.invited).toBe(true);
    expect(t.sessionCookie(await t.signIn())).toBeDefined();
    expect(t.s.users.getByEmail("bo@example.com")!.invited).toBe(false);
  });

  test("the anonymous session names the provider; routes 404 when none is set up", async () => {
    const t = make();
    expect(await (await t.req("/v1/auth/session")).json()).toMatchObject({
      oidc: { label: "Sign in with Example" },
      passwords: true,
    });
    const none = make({ config: null });
    expect(await (await none.req("/v1/auth/session")).json()).toMatchObject({
      oidc: null,
      passwords: true,
    });
    expect((await none.req("/v1/auth/oidc/start")).status).toBe(404);
  });
});

describe("with password sign-in off", () => {
  test("password login, resets, changes and first passwords are refused", async () => {
    const t = make({ passwordsOff: true });
    await t.s.admin();
    expect(await (await t.req("/v1/auth/session")).json()).toMatchObject({
      passwords: false,
      passwordReset: false,
    });
    const login = await t.req("/v1/auth/login", {
      method: "POST",
      json: { email: "ada@example.com", password: PASSWORD },
    });
    expect(login.status).toBe(403);
    expect(
      (
        await t.req("/v1/auth/password-reset", {
          method: "POST",
          json: { email: "ada@example.com" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await t.addUser({ email: "cy@example.com", roleId: ADMIN_ROLE_ID, password: PASSWORD }))
        .status,
    ).toBe(409);
    const ada = t.s.users.getByEmail("ada@example.com")!;
    expect(
      (
        await t.req(`/v1/users/${ada.id}`, {
          method: "PATCH",
          headers: t.admin,
          json: { password: PASSWORD },
        })
      ).status,
    ).toBe(409);
  });

  test("passwords count as on while no provider is set up, so nobody is locked out", async () => {
    const t = make({ passwordsOff: true, config: null });
    await t.s.admin();
    const login = await t.req("/v1/auth/login", {
      method: "POST",
      json: { email: "ada@example.com", password: PASSWORD },
    });
    expect(login.status).toBe(200);
  });
});

describe("sso users", () => {
  test("sso: true needs a provider and makes an account not waiting on anything", async () => {
    const none = make({ config: null });
    await none.s.admin();
    expect(
      (await none.addUser({ email: "bo@example.com", roleId: ADMIN_ROLE_ID, sso: true })).status,
    ).toBe(409);

    const t = make();
    await t.s.admin();
    const res = await t.addUser({ email: "bo@example.com", roleId: ADMIN_ROLE_ID, sso: true });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { user: { invited: boolean } }).user.invited).toBe(false);
    const list = (await (await t.req("/v1/users", { headers: t.admin })).json()) as Record<
      string,
      unknown
    >;
    expect(list).toMatchObject({ sso: { label: "Sign in with Example" }, localLogin: true });
  });

  test("exactly one of password, invite and sso", async () => {
    const t = make();
    await t.s.admin();
    expect((await t.addUser({ email: "bo@example.com", roleId: ADMIN_ROLE_ID })).status).toBe(422);
    expect(
      (
        await t.addUser({
          email: "bo@example.com",
          roleId: ADMIN_ROLE_ID,
          sso: true,
          password: PASSWORD,
        })
      ).status,
    ).toBe(422);
  });
});

describe("sso-only accounts and passwords", () => {
  test("an admin-set password ends an account's sso-only state", async () => {
    const t = await withBo();
    const bo = t.s.users.getByEmail("bo@example.com")!;
    expect(t.s.users.isSsoOnly(bo.id)).toBe(true);
    const res = await t.req(`/v1/users/${bo.id}`, {
      method: "PATCH",
      headers: t.admin,
      json: { password: PASSWORD },
    });
    expect(res.status).toBe(200);
    expect(t.s.users.isSsoOnly(bo.id)).toBe(false);
  });
});
