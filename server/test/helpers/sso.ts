// A fake OpenID Connect provider and the auth routes in front of it, for the sign-in tests.
import { expect } from "bun:test";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { ADMIN_ROLE_ID } from "@gangway/shared/permissions";
import { createApp, surfaceHandler } from "../../src/app/app.ts";
import { authRoutes } from "../../src/app/routes/auth.ts";
import { userRoutes } from "../../src/app/routes/users.ts";
import { staticTokenVerifier } from "../../src/auth/actor.ts";
import { Bootstrap } from "../../src/auth/bootstrap.ts";
import { Sso, type SsoConfig } from "../../src/auth/sso.ts";
import { setupAccounts } from "./accounts.ts";
import type { SignupPolicy } from "../../src/tenancy/signup.ts";
import { silentLogger } from "./logger.ts";
import { HOME_ORG_ID } from "../../src/db/repos/orgs.ts";

export const ISSUER = "https://id.example.test";
export const CLIENT = "gangway-client";
export const SECRET = "client-secret-value";
export const TOKEN = "gw_sso_test_admin_token_0123456789";
export const APP = "https://app.preview.localhost:8443";

export type Keys = { kid: string; alg: "RS256" | "ES256"; priv: KeyObject; jwk: object };

export function keyPair(alg: "RS256" | "ES256", kid: string): Keys {
  const { privateKey, publicKey } =
    alg === "RS256"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { kid, alg, priv: privateKey, jwk: publicKey.export({ format: "jwk" }) };
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

export function jwt(
  k: Keys,
  claims: Record<string, unknown>,
  o: { kid?: string | null } = {},
): string {
  const header = { alg: k.alg, typ: "JWT", ...(o.kid === null ? {} : { kid: o.kid ?? k.kid }) };
  const data = `${b64(header)}.${b64(claims)}`;
  const sig =
    k.alg === "RS256"
      ? sign("RSA-SHA256", Buffer.from(data), k.priv)
      : sign("sha256", Buffer.from(data), { key: k.priv, dsaEncoding: "ieee-p1363" });
  return `${data}.${sig.toString("base64url")}`;
}

/** A provider: discovery, JWKS and a token endpoint that checks PKCE and client_secret_basic. */
export function provider(o: { keys?: Keys[] } = {}) {
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

export function make(
  o: {
    config?: SsoConfig | null;
    passwordsOff?: boolean;
    keys?: Keys[];
    signup?: SignupPolicy | null;
  } = {},
) {
  const s = setupAccounts({ signup: o.signup ?? null });
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
    verifyToken: staticTokenVerifier(TOKEN, HOME_ORG_ID),
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

export async function withBo(o: Parameters<typeof make>[0] = {}) {
  const t = make(o);
  await t.s.admin();
  const res = await t.addUser({ email: "bo@example.com", roleId: ADMIN_ROLE_ID, sso: true });
  expect(res.status).toBe(201);
  return t;
}
