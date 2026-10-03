import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { ADMIN_ROLE_ID } from "@gangway/shared/permissions";
import { createApp, surfaceHandler } from "../../src/app/app.ts";
import { authRoutes } from "../../src/app/routes/auth.ts";
import { userRoutes } from "../../src/app/routes/users.ts";
import { staticTokenVerifier } from "../../src/auth/actor.ts";
import { Bootstrap } from "../../src/auth/bootstrap.ts";
import { Sso, type SsoConfig } from "../../src/auth/sso.ts";
import { PASSWORD, setupAccounts } from "../helpers/accounts.ts";
import { silentLogger } from "../helpers/logger.ts";

const ISSUER = "https://id.example.test";
const CLIENT = "gangway-client";
const SECRET = "client-secret-value";
const TOKEN = "gw_sso_test_admin_token_0123456789";
const APP = "https://app.preview.localhost:8443";

type Keys = { kid: string; alg: "RS256" | "ES256"; priv: KeyObject; jwk: object };

function keyPair(alg: "RS256" | "ES256", kid: string): Keys {
  const { privateKey, publicKey } =
    alg === "RS256"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { kid, alg, priv: privateKey, jwk: publicKey.export({ format: "jwk" }) };
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

function jwt(k: Keys, claims: Record<string, unknown>, o: { kid?: string | null } = {}): string {
  const header = { alg: k.alg, typ: "JWT", ...(o.kid === null ? {} : { kid: o.kid ?? k.kid }) };
  const data = `${b64(header)}.${b64(claims)}`;
  const sig =
    k.alg === "RS256"
      ? sign("RSA-SHA256", Buffer.from(data), k.priv)
      : sign("sha256", Buffer.from(data), { key: k.priv, dsaEncoding: "ieee-p1363" });
  return `${data}.${sig.toString("base64url")}`;
}

/** A provider: discovery, JWKS and a token endpoint that checks PKCE and client_secret_basic. */
function provider(o: { keys?: Keys[] } = {}) {
  const keys = o.keys ?? [keyPair("RS256", "k1")];
  const state = {
    challenge: "",
    nonce: "",
    claims: {} as Record<string, unknown>,
    signer: keys[0]!,
    kid: undefined as string | null | undefined,
    token: null as string | null,
    tokenCalls: 0,
    basic: "",
  };
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
      });
    }
    if (url === `${ISSUER}/jwks`) {
      return Response.json({ keys: keys.map((k) => ({ ...k.jwk, kid: k.kid, use: "sig" })) });
    }
    if (url === `${ISSUER}/token`) {
      state.tokenCalls++;
      state.basic = new Headers(init?.headers).get("authorization") ?? "";
      const form = new URLSearchParams(String(init?.body));
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (
        challenge !== state.challenge ||
        form.get("redirect_uri") !== `${APP}/v1/auth/oidc/callback`
      ) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      const now = Math.floor(Date.now() / 1000);
      const id = jwt(
        state.signer,
        {
          iss: ISSUER,
          aud: CLIENT,
          sub: "subject-1",
          email: "bo@example.com",
          email_verified: true,
          iat: now,
          exp: now + 300,
          nonce: state.nonce,
          ...state.claims,
        },
        state.kid === undefined ? {} : { kid: state.kid },
      );
      return Response.json({
        access_token: "at",
        token_type: "Bearer",
        id_token: state.token ?? id,
      });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, state, keys };
}

function make(o: { config?: SsoConfig | null; passwordsOff?: boolean; keys?: Keys[] } = {}) {
  const s = setupAccounts();
  const p = provider(o.keys ? { keys: o.keys } : {});
  const bootstrap = new Bootstrap(() => s.users.count());
  const config: SsoConfig | null =
    o.config === undefined
      ? { issuer: ISSUER, clientId: CLIENT, clientSecret: SECRET, label: "Sign in with Example" }
      : o.config;
  const sso = new Sso({
    config: () => config,
    redirectUri: () => `${APP}/v1/auth/oidc/callback`,
    fetch: p.fetch,
  });
  const passwords = () => !(o.passwordsOff === true && sso.configured);
  const auth = {
    verifyToken: staticTokenVerifier(TOKEN),
    resolveSession: (secret: string) => s.sessions.resolve(secret)?.actor ?? null,
    originFor: (host: string) => `https://${host}`,
  };
  const app = createApp({
    ...auth,
    logger: silentLogger(),
    v1: (api) => userRoutes(api, s.accounts, undefined, { sso, passwords }),
    publicV1: (pub) =>
      authRoutes(pub, {
        auth,
        accounts: s.accounts,
        bootstrap,
        roles: s.roles,
        sessionMaxAgeSec: 2_592_000,
        sso,
        passwords,
      }),
  });
  const h = surfaceHandler(app, "app");
  const req = (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", "app.preview.localhost:8443");
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
    }
    return Promise.resolve(
      h(
        new Request(`${APP}${path}`, {
          ...init,
          headers,
          ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
        }),
        { clientIp: "203.0.113.7" },
      ),
    );
  };
  const admin = { authorization: `Bearer ${TOKEN}` };

  /** Starts a sign-in, plays the provider, and calls back; returns the callback's response. */
  const signIn = async (o: { next?: string; tamperState?: boolean; noCookie?: boolean } = {}) => {
    const start = await req(
      `/v1/auth/oidc/start${o.next ? `?next=${encodeURIComponent(o.next)}` : ""}`,
    );
    expect(start.status).toBe(302);
    const to = new URL(start.headers.get("location")!);
    p.state.challenge = to.searchParams.get("code_challenge")!;
    p.state.nonce ||= to.searchParams.get("nonce")!;
    const state = to.searchParams.get("state")!;
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    const sentState = o.tamperState ? `${state}x` : state;
    return req(`/v1/auth/oidc/callback?code=abc&state=${sentState}`, {
      headers: o.noCookie ? {} : { cookie },
    });
  };
  const sessionCookie = (res: Response) =>
    res.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Host-gw_session="))
      ?.split(";")[0];
  const addUser = (body: Record<string, unknown>) =>
    req("/v1/users", { method: "POST", headers: admin, json: body });
  return { s, p, sso, req, signIn, sessionCookie, addUser, admin };
}

async function withBo(o: Parameters<typeof make>[0] = {}) {
  const t = make(o);
  await t.s.admin();
  const res = await t.addUser({ email: "bo@example.com", roleId: ADMIN_ROLE_ID, sso: true });
  expect(res.status).toBe(201);
  return t;
}

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
