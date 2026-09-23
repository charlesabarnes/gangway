import { createHash, randomBytes } from "node:crypto";
import { createApp, surfaceHandler } from "../../src/app/app.ts";
import { McpSurface } from "../../src/app/mcp-surface.ts";
import { authRoutes } from "../../src/app/routes/auth.ts";
import { oauthRootRoutes, oauthRoutes } from "../../src/app/routes/oauth.ts";
import { chainVerifiers, staticTokenVerifier } from "../../src/auth/actor.ts";
import { Bootstrap } from "../../src/auth/bootstrap.ts";
import { Tokens } from "../../src/auth/tokens.ts";
import { IdempotencyRepo, OAuthGrantsRepo } from "../../src/db/repos/index.ts";
import { Tools } from "../../src/mcp/tools.ts";
import { ClientMetadataError } from "../../src/oauth/client-metadata.ts";
import { OAuthServer } from "../../src/oauth/server.ts";
import { IdempotentDeploys } from "../../src/previews/idempotent.ts";
import { PASSWORD, setupAccounts } from "./accounts.ts";
import { silentLogger } from "./logger.ts";
import { setupPreviewContext } from "./preview-context.ts";

export const CLAUDE = "https://claude.ai/oauth/claude-code-client-metadata";
export const CONNECTOR = "https://claude.ai/api/mcp/auth_callback";
export const ISSUER = "https://app.preview.localhost:8443";
export const RESOURCE = "https://mcp.preview.localhost:8443";
export const MCP_HOST = "mcp.preview.localhost:8443";

export const verifierFor = () => randomBytes(32).toString("base64url");
export const challengeOf = (v: string) => createHash("sha256").update(v).digest("base64url");

/** An OAuthServer over real accounts, with claude.ai's client document known and `ada` as admin. */
export async function setupOAuth() {
  const s = setupAccounts();
  const { user } = await s.admin();
  const grants = new OAuthGrantsRepo(s.db, s.now);
  const docs: Record<string, string[]> = { [CLAUDE]: [CONNECTOR, "http://localhost/callback"] };
  const oauth = new OAuthServer({
    grants,
    roles: s.roles,
    audit: s.audit,
    issuer: () => ISSUER,
    resource: () => RESOURCE,
    now: s.now,
    clients: {
      get: async (id) => {
        const r = docs[id];
        if (!r) throw new ClientMetadataError("unknown");
        return { clientId: id, clientName: "Claude", redirectUris: r };
      },
    },
  });
  const ada = {
    kind: "user",
    userId: user.id,
    roleId: "admin",
    sessionId: "s",
    permissions: s.roles.for("admin"),
  } as const;
  const verifier = verifierFor();
  const authorizeQuery = (over: Record<string, string | null> = {}) => {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: CLAUDE,
      redirect_uri: CONNECTOR,
      code_challenge: challengeOf(verifier),
      code_challenge_method: "S256",
      state: "xyz",
      scope: "read deploy",
      resource: RESOURCE,
    });
    for (const [k, v] of Object.entries(over))
      if (v === null) q.delete(k);
      else q.set(k, v);
    return q;
  };
  /** Straight through to a code, as a user would click. */
  const code = async (actor: typeof ada = ada, scopes?: string[]) => {
    // The request asks for what will be granted, when that is more than the default.
    const out = await oauth.authorize(
      authorizeQuery(scopes?.includes("update") ? { scope: scopes.join(" ") } : {}),
    );
    if (out.kind !== "consent") throw new Error(JSON.stringify(out));
    const { redirect } = oauth.decide(actor, out.requestId, {
      approve: true,
      ...(scopes ? { scopes } : {}),
    });
    return new URL(redirect).searchParams.get("code")!;
  };
  const exchange = (c: string, over: Record<string, string> = {}) =>
    oauth.token(
      new URLSearchParams({
        grant_type: "authorization_code",
        code: c,
        client_id: CLAUDE,
        redirect_uri: CONNECTOR,
        code_verifier: verifier,
        resource: RESOURCE,
        ...over,
      }),
    );
  const refresh = (token: string, over: Record<string, string> = {}) =>
    oauth.token(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token,
        client_id: CLAUDE,
        ...over,
      }),
    );
  return { ...s, grants, oauth, ada, docs, authorizeQuery, code, exchange, refresh, user };
}

/** The app, API and MCP surfaces wired to one OAuthServer, with `ada` signed in on the app. */
export async function oauthOverHttp() {
  const quiet = silentLogger();
  const s = await setupOAuth();
  const p = setupPreviewContext();
  const tokens = new Tokens(s.tokensRepo, s.roles, s.audit, s.now);
  const auth = {
    verifyToken: chainVerifiers(
      tokens.verify,
      staticTokenVerifier("gw_http_env_token_0123456789abcdefghij"),
    ),
    resolveSession: (secret: string) => s.sessions.resolve(secret)?.actor ?? null,
    originFor: (host: string) => `https://${host}`,
  };
  let mcpOn = true,
    uiOn = true;
  const app = createApp({
    ...auth,
    logger: quiet,
    root: (r) => oauthRootRoutes(r, { oauth: s.oauth, enabled: () => mcpOn }),
    v1: (api) => oauthRoutes(api, { oauth: s.oauth, enabled: () => mcpOn }),
    publicV1: (pub) =>
      authRoutes(pub, {
        auth,
        accounts: s.accounts,
        bootstrap: new Bootstrap(() => s.users.count()),
        roles: s.roles,
        sessionMaxAgeSec: 60,
      }),
  });
  const appH = surfaceHandler(app, "app");
  const apiH = surfaceHandler(app, "api");
  const tools = new Tools({
    ctx: p.ctx,
    deploys: new IdempotentDeploys(p.ctx, new IdempotencyRepo(p.db, p.ctx.now)),
    logger: quiet,
  });
  const mcp = new McpSurface({
    tools,
    logger: quiet,
    verifyToken: chainVerifiers(tokens.verify, s.oauth.verify),
    oauth: {
      available: () => uiOn,
      resource: () => RESOURCE,
      resourceMetadata: () => s.oauth.resourceMetadata(),
    },
  });
  const mcpH = mcp.handler();
  const HOST = "app.preview.localhost:8443";
  const call = (
    h: typeof appH,
    host: string,
    path: string,
    init: RequestInit & { cookie?: string } = {},
  ) => {
    const headers = new Headers(init.headers);
    headers.set("host", host);
    if (init.cookie) {
      headers.set("cookie", init.cookie);
      headers.set("origin", `https://${host}`);
    }
    return Promise.resolve(
      h(new Request(`https://${host}${path}`, { ...init, headers }), { clientIp: "203.0.113.5" }),
    );
  };
  const login = await call(appH, HOST, "/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: `https://${HOST}` },
    body: JSON.stringify({ email: "ada@example.com", password: PASSWORD }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const toolCall = (token: string, name: string, args: unknown) =>
    call(mcpH, MCP_HOST, "/", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
  return {
    ...s,
    p,
    appH,
    apiH,
    mcpH,
    call,
    cookie,
    HOST,
    toolCall,
    setMcp: (v: boolean) => {
      mcpOn = v;
    },
    setUi: (v: boolean) => {
      uiOn = v;
    },
  };
}
