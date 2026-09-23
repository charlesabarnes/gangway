import type { Hono } from "hono";
import { createApp, surfaceHandler } from "../../src/app/app.ts";
import type { AppEnv } from "../../src/app/env.ts";
import { authRoutes } from "../../src/app/routes/auth.ts";
import { chainVerifiers, staticTokenVerifier } from "../../src/auth/actor.ts";
import { Bootstrap } from "../../src/auth/bootstrap.ts";
import { Tokens } from "../../src/auth/tokens.ts";
import { PASSWORD, type setupAccounts } from "./accounts.ts";
import { silentLogger } from "./logger.ts";

const HOST = "app.preview.localhost:8443";

/** The app surface: `v1` beside the real auth routes, the first admin made and signed in as `ada`. */
export async function signedInApp(
  s: ReturnType<typeof setupAccounts>,
  o: { envToken: string; v1: (api: Hono<AppEnv>, tokens: Tokens) => void },
) {
  const tokens = new Tokens(s.tokensRepo, s.roles, s.audit, s.now);
  const auth = {
    verifyToken: chainVerifiers(tokens.verify, staticTokenVerifier(o.envToken)),
    resolveSession: (secret: string) => s.sessions.resolve(secret)?.actor ?? null,
    originFor: (host: string) => `https://${host}`,
  };
  const app = createApp({
    ...auth,
    logger: silentLogger(),
    v1: (api) => o.v1(api, tokens),
    publicV1: (pub) =>
      authRoutes(pub, {
        auth,
        accounts: s.accounts,
        bootstrap: new Bootstrap(() => s.users.count()),
        roles: s.roles,
        sessionMaxAgeSec: 60,
      }),
  });
  const handle = surfaceHandler(app, "app");
  const call = (path: string, init: RequestInit & { json?: unknown; as?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", HOST);
    headers.set("origin", `https://${HOST}`);
    if (init.as?.startsWith("gw_")) headers.set("authorization", `Bearer ${init.as}`);
    else if (init.as) headers.set("cookie", init.as);
    if (init.json !== undefined) headers.set("content-type", "application/json");
    return Promise.resolve(
      handle(
        new Request(`https://${HOST}${path}`, {
          ...init,
          headers,
          ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
        }),
        { clientIp: "203.0.113.7" },
      ),
    );
  };
  const { user: admin } = await s.admin();
  const login = async (email: string, password = PASSWORD) =>
    (await call("/v1/auth/login", { method: "POST", json: { email, password } })).headers
      .get("set-cookie")!
      .split(";")[0]!;
  const ada = await login("ada@example.com");
  return { tokens, call, login, ada, admin };
}
