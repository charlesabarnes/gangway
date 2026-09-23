/**
 * ADR-0020: the OAuth 2.1 authorization server for MCP clients. The CIMD fetcher's address
 * rules, the authorize endpoint's validation, codes, PKCE, refresh rotation and replay, the
 * audience rule (an OAuth token opens MCP and nothing else), and the whole flow over HTTP.
 */
import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { createApp, surfaceHandler } from "../../src/app/app.ts";
import { McpSurface } from "../../src/app/mcp-surface.ts";
import { authRoutes } from "../../src/app/routes/auth.ts";
import { oauthRootRoutes, oauthRoutes } from "../../src/app/routes/oauth.ts";
import { chainVerifiers, staticTokenVerifier, type Actor } from "../../src/auth/actor.ts";
import { Bootstrap } from "../../src/auth/bootstrap.ts";
import { Tokens } from "../../src/auth/tokens.ts";
import { IdempotencyRepo, OAuthGrantsRepo } from "../../src/db/repos/index.ts";
import { Logger } from "../../src/logger.ts";
import { Tools } from "../../src/mcp/tools.ts";
import {
  checkClientIdUrl, ClientMetadataError, ClientMetadataStore, fetchDocument, isPublicAddress, parseDocument, redirectAllowed, type Fetched,
} from "../../src/oauth/client-metadata.ts";
import { ACCESS_TTL_MS, OAuthServer, REFRESH_IDLE_MS } from "../../src/oauth/server.ts";
import { IdempotentDeploys } from "../../src/previews/idempotent.ts";
import { PASSWORD, setupAccounts } from "../helpers/accounts.ts";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";
import { SourceStore } from "../../src/previews/source/store.ts";
import { dirname } from "node:path";

const quiet = new Logger("error", {}, () => {});
const CLAUDE = "https://claude.ai/oauth/claude-code-client-metadata";
const CONNECTOR = "https://claude.ai/api/mcp/auth_callback";
const ISSUER = "https://app.preview.localhost:8443";
const RESOURCE = "https://mcp.preview.localhost:8443";

describe("client metadata documents: what may be fetched", () => {
  test.each([
    ["127.0.0.1", false], ["10.1.2.3", false], ["172.17.0.1", false], ["192.168.1.1", false], ["100.103.231.69", false],
    ["169.254.169.254", false], ["0.0.0.0", false], ["::1", false], ["fe80::1", false], ["fd00::1", false], ["::ffff:127.0.0.1", false],
    ["::ffff:10.0.0.1", false], ["not-an-ip", false],
    ["160.79.104.10", true], ["8.8.8.8", true], ["2606:4700::1111", true], ["::ffff:8.8.8.8", true],
  ])("%s public: %p", (ip, ok) => expect(isPublicAddress(ip)).toBe(ok));

  test.each([
    ["http://claude.ai/x", "https"],
    ["https://claude.ai:8443/x", "default https port"],
    ["https://u:p@claude.ai/x", "credentials"],
    ["https://claude.ai/x#frag", "fragment"],
    ["https://claude.ai/", "path"],
    ["https://127.0.0.1/x", "not an address"],
    ["https://CLAUDE.ai/x", "normalized"],
    ["nope", "not a URL"],
  ])("client_id %s is refused (%s)", (url, why) => expect(() => checkClientIdUrl(url)).toThrow(why));

  test("a name that resolves to loopback is refused at connect time", async () => {
    await expect(fetchDocument(new URL("https://localhost/client.json"))).rejects.toThrow("non-public address");
  });

  const ok = (doc: unknown, over: Partial<Fetched> = {}): Fetched => ({ status: 200, contentType: "application/json", cacheControl: "", body: JSON.stringify(doc), ...over });

  test("the document must name itself, list redirects, and be a public client", () => {
    expect(parseDocument(CLAUDE, ok({ client_id: CLAUDE, client_name: "Claude Code", redirect_uris: ["http://localhost/callback"] })))
      .toEqual({ clientId: CLAUDE, clientName: "Claude Code", redirectUris: ["http://localhost/callback"] });
    expect(() => parseDocument(CLAUDE, ok({ client_id: "https://evil.example/x", redirect_uris: ["https://x/cb"] }))).toThrow("does not match");
    expect(() => parseDocument(CLAUDE, ok({ client_id: CLAUDE, redirect_uris: [] }))).toThrow("redirect_uris");
    expect(() => parseDocument(CLAUDE, ok({ client_id: CLAUDE, redirect_uris: ["https://x/cb"], token_endpoint_auth_method: "client_secret_basic" }))).toThrow("public clients");
    expect(() => parseDocument(CLAUDE, ok({}, { status: 404 }))).toThrow("404");
    expect(() => parseDocument(CLAUDE, ok({}, { contentType: "text/html" }))).toThrow("not JSON");
    // A name is for a person to read: no bidi tricks, no control characters, not a novel.
    expect(parseDocument(CLAUDE, ok({ client_id: CLAUDE, client_name: "Cla\u202eude\u0000", redirect_uris: ["https://x/cb"] })).clientName).toBe("Claude");
    expect(parseDocument(CLAUDE, ok({ client_id: CLAUDE, redirect_uris: ["https://x/cb"] })).clientName).toBe("claude.ai");
  });

  test("cached per Cache-Control within 5 min .. 24 h; a failure is not cached", async () => {
    let t = 0, calls = 0, fail = true;
    const store = new ClientMetadataStore({
      now: () => t,
      fetch: async () => { calls++; if (fail) throw new Error("boom"); return ok({ client_id: CLAUDE, redirect_uris: ["https://x/cb"] }, { cacheControl: "max-age=1" }); },
    });
    await expect(store.get(CLAUDE)).rejects.toBeInstanceOf(ClientMetadataError);
    fail = false;
    await store.get(CLAUDE);
    await store.get(CLAUDE);
    expect(calls).toBe(2);
    t += 5 * 60_000 + 1;
    await store.get(CLAUDE);
    expect(calls).toBe(3);
  });

  test("redirects: exact, except loopback, which ignores the port", () => {
    const reg = ["http://localhost/callback", "http://127.0.0.1/callback", CONNECTOR];
    expect(redirectAllowed(CONNECTOR, reg)).toBe(true);
    expect(redirectAllowed("http://localhost:53682/callback", reg)).toBe(true);
    expect(redirectAllowed("http://127.0.0.1:1234/callback", reg)).toBe(true);
    expect(redirectAllowed("http://localhost:53682/other", reg)).toBe(false);
    expect(redirectAllowed("https://claude.ai/api/mcp/auth_callback/", reg)).toBe(false);
    expect(redirectAllowed("https://evil.example/cb", reg)).toBe(false);
    expect(redirectAllowed("http://localhost.evil.example/callback", reg)).toBe(false);
  });
});

/* ------------------------------------------------------------------ the server */

const verifierFor = () => randomBytes(32).toString("base64url");
const challengeOf = (v: string) => createHash("sha256").update(v).digest("base64url");

async function setup() {
  const s = setupAccounts();
  const { user } = await s.admin();
  const grants = new OAuthGrantsRepo(s.db, s.now);
  const docs: Record<string, string[]> = { [CLAUDE]: [CONNECTOR, "http://localhost/callback"] };
  const oauth = new OAuthServer({
    grants, roles: s.roles, audit: s.audit, issuer: () => ISSUER, resource: () => RESOURCE, now: s.now,
    clients: { get: async (id) => { const r = docs[id]; if (!r) throw new ClientMetadataError("unknown"); return { clientId: id, clientName: "Claude", redirectUris: r }; } },
  });
  const ada = { kind: "user", userId: user.id, roleId: "admin", sessionId: "s", permissions: s.roles.for("admin") } as const;
  const verifier = verifierFor();
  const authorizeQuery = (over: Record<string, string | null> = {}) => {
    const q = new URLSearchParams({
      response_type: "code", client_id: CLAUDE, redirect_uri: CONNECTOR, code_challenge: challengeOf(verifier), code_challenge_method: "S256",
      state: "xyz", scope: "read deploy", resource: RESOURCE,
    });
    for (const [k, v] of Object.entries(over)) if (v === null) q.delete(k); else q.set(k, v);
    return q;
  };
  /** Straight through to a code, as a user would click. */
  const code = async (actor: typeof ada = ada, scopes?: string[]) => {
    // The request asks for what will be granted, when that is more than the default.
    const out = await oauth.authorize(authorizeQuery(scopes?.includes("update") ? { scope: scopes.join(" ") } : {}));
    if (out.kind !== "consent") throw new Error(JSON.stringify(out));
    const { redirect } = oauth.decide(actor, out.requestId, { approve: true, ...(scopes ? { scopes } : {}) });
    return new URL(redirect).searchParams.get("code")!;
  };
  const exchange = (c: string, over: Record<string, string> = {}) => oauth.token(new URLSearchParams({
    grant_type: "authorization_code", code: c, client_id: CLAUDE, redirect_uri: CONNECTOR, code_verifier: verifier, resource: RESOURCE, ...over,
  }));
  const refresh = (token: string, over: Record<string, string> = {}) => oauth.token(new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: CLAUDE, ...over }));
  return { ...s, grants, oauth, ada, docs, authorizeQuery, code, exchange, refresh, user };
}

describe("authorize: nothing is redirected until the redirect is trusted", () => {
  test.each([
    [{ client_id: null }, "no client"],
    [{ redirect_uri: null }, "no redirect_uri"],
    [{ client_id: "https://unknown.example/c" }, "could not be identified"],
    [{ redirect_uri: "https://evil.example/cb" }, "did not register"],
  ])("%j is an error page", async (over, why) => {
    const s = await setup();
    const out = await s.oauth.authorize(s.authorizeQuery(over));
    expect(out.kind).toBe("page");
    expect((out as { error: string }).error).toContain(why);
  });

  test.each([
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ code_challenge: null }, "invalid_request"],
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ resource: "https://api.preview.localhost:8443" }, "invalid_target"],
    [{ scope: "read admin" }, "invalid_scope"],
  ])("%j goes back to the client as %s, with state and iss", async (over, error) => {
    const s = await setup();
    const out = await s.oauth.authorize(s.authorizeQuery(over));
    expect(out.kind).toBe("redirect");
    const u = new URL((out as { url: string }).url);
    expect(`${u.origin}${u.pathname}`).toBe(CONNECTOR);
    expect(u.searchParams.get("error")).toBe(error);
    expect(u.searchParams.get("state")).toBe("xyz");
    expect(u.searchParams.get("iss")).toBe(ISSUER);
  });

  test("a repeated parameter is refused; offline_access is accepted and ignored; no scope means both", async () => {
    const s = await setup();
    const q = s.authorizeQuery(); q.append("scope", "read");
    expect(new URL(((await s.oauth.authorize(q)) as { url: string }).url).searchParams.get("error")).toBe("invalid_request");
    const off = await s.oauth.authorize(s.authorizeQuery({ scope: "deploy offline_access" }));
    expect(s.oauth.view(s.ada, (off as { requestId: string }).requestId).requested).toEqual(["deploy"]);
    const none = await s.oauth.authorize(s.authorizeQuery({ scope: null }));
    expect(s.oauth.view(s.ada, (none as { requestId: string }).requestId).requested).toEqual(["read", "deploy"]);
  });
});

describe("consent", () => {
  test("the view names the client's host and the redirect's; deny goes back as access_denied and spends the request", async () => {
    const s = await setup();
    const out = await s.oauth.authorize(s.authorizeQuery());
    const id = (out as { requestId: string }).requestId;
    expect(s.oauth.view(s.ada, id)).toMatchObject({ client: { name: "Claude", host: "claude.ai" }, redirectHost: "claude.ai", requested: ["read", "deploy"], grantable: ["read", "deploy"] });
    const { redirect } = s.oauth.decide(s.ada, id, { approve: false });
    expect(new URL(redirect).searchParams.get("error")).toBe("access_denied");
    expect(() => s.oauth.view(s.ada, id)).toThrow("expired or was already answered");
  });

  test("only a person can consent; a token cannot, not even the env admin token", async () => {
    const s = await setup();
    const id = ((await s.oauth.authorize(s.authorizeQuery())) as { requestId: string }).requestId;
    const env = staticTokenVerifier("gw_env")("gw_env") as Actor;
    expect(() => s.oauth.view(env, id)).toThrow("only a person");
    expect(() => s.oauth.decide(env, id, { approve: true })).toThrow("only a person");
  });

  test("a viewer can grant read but not deploy (strict, like minting a token)", async () => {
    const s = await setup();
    const viewer = { kind: "user", userId: s.user.id, roleId: "viewer", sessionId: "s", permissions: s.roles.for("viewer") } as never;
    const id = ((await s.oauth.authorize(s.authorizeQuery())) as { requestId: string }).requestId;
    expect(s.oauth.view(viewer, id).grantable).toEqual(["read"]);
    expect(() => s.oauth.decide(viewer, id, { approve: true, scopes: ["read", "deploy"] })).toThrow("cannot grant deploy");
    expect(() => s.oauth.decide(viewer, id, { approve: true, scopes: [] })).toThrow("at least one scope");
    const { redirect } = s.oauth.decide(viewer, id, { approve: true, scopes: ["read"] });
    expect(new URL(redirect).searchParams.get("code")).toBeTruthy();
  });

  test("a pending request lives 10 minutes", async () => {
    const s = await setup();
    const id = ((await s.oauth.authorize(s.authorizeQuery())) as { requestId: string }).requestId;
    s.clock.t += 10 * 60_000 + 1;
    expect(() => s.oauth.view(s.ada, id)).toThrow("expired");
  });
});

describe("tokens", () => {
  test("code -> tokens; the access token acts as the user, clamped to the scopes; the grant is audited", async () => {
    const s = await setup();
    const t = s.exchange(await s.code(s.ada, ["read"]));
    expect(t).toMatchObject({ token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, scope: "read" });
    expect(t.access_token).toMatch(/^gwa_/);
    expect(t.refresh_token).toMatch(/^gwr_/);
    const actor = (await s.oauth.verify(t.access_token))!;
    expect(actor).toMatchObject({ kind: "token", userId: s.user.id, scopes: ["read"] });
    expect(actor.permissions.has("previews.read")).toBe(true);
    expect(actor.permissions.has("previews.deploy")).toBe(false);
    expect(s.actions()).toContain("oauth.grant.created");
    expect(JSON.stringify(s.auditRepo.page({ limit: 50 }))).not.toContain(t.access_token);
  });

  test("a code is single-use, lives 60 s, and a replay revokes what it made", async () => {
    const s = await setup();
    const c = await s.code();
    const t = s.exchange(c);
    expect(() => s.exchange(c)).toThrow("already used");
    expect(await s.oauth.verify(t.access_token)).toBeNull();
    const late = await s.code();
    s.clock.t += 60_001;
    expect(() => s.exchange(late)).toThrow("unknown or expired");
  });

  test.each([
    [{ code_verifier: "x".repeat(43) }, "does not match"],
    [{ code_verifier: "short" }, "malformed"],
    [{ client_id: "https://other.example/c" }, "another client"],
    [{ redirect_uri: "http://localhost:9/callback" }, "redirect_uri does not match"],
    [{ resource: "https://api.preview.localhost:8443" }, "only for"],
  ])("the exchange refuses %j", async (over, why) => {
    const s = await setup();
    const c = await s.code();
    expect(() => s.exchange(c, over)).toThrow(why);
  });

  test("refresh rotates both tokens; the old refresh token replayed revokes the grant", async () => {
    const s = await setup();
    const first = s.exchange(await s.code());
    const second = s.refresh(first.refresh_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(await s.oauth.verify(first.access_token)).toBeNull();
    expect(await s.oauth.verify(second.access_token)).not.toBeNull();

    expect(() => s.refresh(first.refresh_token)).toThrow("not valid");
    expect(await s.oauth.verify(second.access_token)).toBeNull();
    expect(() => s.refresh(second.refresh_token)).toThrow("not valid");
    expect(s.actions().filter((a) => a === "oauth.grant.revoked")).toHaveLength(1);
  });

  test("refresh cannot widen, cannot outlive 30 idle days, and follows the account", async () => {
    const s = await setup();
    const t = s.exchange(await s.code(s.ada, ["read"]));
    expect(() => s.refresh(t.refresh_token, { scope: "deploy" })).toThrow("cannot widen");
    s.clock.t += REFRESH_IDLE_MS + 1;
    expect(() => s.refresh(t.refresh_token)).toThrow("expired");

    const u = s.exchange(await s.code());
    s.oauth.revokeAllFor(s.user.id);
    expect(await s.oauth.verify(u.access_token)).toBeNull();
    expect(() => s.refresh(u.refresh_token)).toThrow("not valid");
  });

  test("a demoted owner's token shrinks at once; a disabled owner's stops; an access token lives an hour", async () => {
    const s = await setup();
    const t = s.exchange(await s.code());
    expect((await s.oauth.verify(t.access_token))!.permissions.has("previews.deploy")).toBe(true);
    s.users.update(s.user.id, { roleId: "viewer" });
    const demoted = (await s.oauth.verify(t.access_token))!;
    expect(demoted.permissions.has("previews.deploy")).toBe(false);
    expect(demoted.permissions.has("previews.read")).toBe(true);
    s.users.update(s.user.id, { disabled: true });
    expect(await s.oauth.verify(t.access_token)).toBeNull();
    s.users.update(s.user.id, { disabled: false, roleId: "admin" });
    s.clock.t += ACCESS_TTL_MS + 1;
    expect(await s.oauth.verify(t.access_token)).toBeNull();
  });

  test("list and revoke: your own; someone else's is a 404", async () => {
    const s = await setup();
    s.exchange(await s.code());
    const [g] = s.oauth.list(s.ada);
    expect(g).toMatchObject({ clientId: CLAUDE, clientName: "Claude", redirectUri: CONNECTOR, scopes: ["read", "deploy"] });
    const other = { ...s.ada, userId: "someone-else", permissions: new Set(["tokens.manage_own"]) } as never;
    expect(() => s.oauth.revoke(other, g!.id)).toThrow("no such connection");
    expect(s.oauth.revoke(s.ada, g!.id).revokedAt).not.toBeNull();
    expect(s.oauth.list(s.ada)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ over HTTP */

async function http() {
  const s = await setup();
  const p = setupPreviewContext();
  const tokens = new Tokens(s.tokensRepo, s.roles, s.audit, s.now);
  const auth = {
    verifyToken: chainVerifiers(tokens.verify, staticTokenVerifier("gw_http_env_token_0123456789abcdefghij")),
    resolveSession: (secret: string) => s.sessions.resolve(secret)?.actor ?? null,
    originFor: (host: string) => `https://${host}`,
  };
  let mcpOn = true, uiOn = true;
  const app = createApp({
    ...auth, logger: quiet,
    root: (r) => oauthRootRoutes(r, { oauth: s.oauth, enabled: () => mcpOn }),
    v1: (api) => oauthRoutes(api, { oauth: s.oauth, enabled: () => mcpOn }),
    publicV1: (pub) => authRoutes(pub, { auth, accounts: s.accounts, bootstrap: new Bootstrap(() => s.users.count()), roles: s.roles, sessionMaxAgeSec: 60 }),
  });
  const appH = surfaceHandler(app, "app");
  const apiH = surfaceHandler(app, "api");
  const tools = new Tools({ ctx: p.ctx, deploys: new IdempotentDeploys(p.ctx, new IdempotencyRepo(p.db, p.ctx.now)), logger: quiet });
  const mcp = new McpSurface({
    tools, logger: quiet, verifyToken: chainVerifiers(tokens.verify, s.oauth.verify),
    oauth: { available: () => uiOn, resource: () => RESOURCE, resourceMetadata: () => s.oauth.resourceMetadata() },
  });
  const mcpH = mcp.handler();
  const HOST = "app.preview.localhost:8443";
  const call = (h: typeof appH, host: string, path: string, init: RequestInit & { cookie?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", host);
    if (init.cookie) { headers.set("cookie", init.cookie); headers.set("origin", `https://${host}`); }
    return Promise.resolve(h(new Request(`https://${host}${path}`, { ...init, headers }), { clientIp: "203.0.113.5" }));
  };
  const login = await call(appH, HOST, "/v1/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: `https://${HOST}` }, body: JSON.stringify({ email: "ada@example.com", password: PASSWORD }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const toolCall = (token: string, name: string, args: unknown) => call(mcpH, "mcp.preview.localhost:8443", "/", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return { ...s, p, appH, apiH, mcpH, call, cookie, HOST, toolCall, setMcp: (v: boolean) => { mcpOn = v; }, setUi: (v: boolean) => { uiOn = v; } };
}

describe("the flow over HTTP, as claude.ai drives it", () => {
  test("401 -> resource metadata -> AS metadata -> authorize -> /connect -> approve -> token -> a tool call", async () => {
    const h = await http();
    // 1. The MCP surface says where to go.
    const denied = await h.call(h.mcpH, "mcp.preview.localhost:8443", "/", { method: "POST", body: "{}" });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${RESOURCE}/.well-known/oauth-protected-resource", scope="read deploy"`);
    const prm = await (await h.call(h.mcpH, "mcp.preview.localhost:8443", "/.well-known/oauth-protected-resource")).json();
    expect(prm).toMatchObject({ resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: ["read", "deploy", "update"] });
    // 2. The authorization server describes itself.
    const as = await (await h.call(h.appH, h.HOST, "/.well-known/oauth-authorization-server")).json() as Record<string, unknown>;
    expect(as).toMatchObject({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/oauth/authorize`, token_endpoint: `${ISSUER}/oauth/token`, code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true, token_endpoint_auth_methods_supported: ["none"] });
    // 3. The browser arrives at authorize and is sent to the consent page.
    const verifier = verifierFor();
    const q = new URLSearchParams({ response_type: "code", client_id: CLAUDE, redirect_uri: CONNECTOR, code_challenge: challengeOf(verifier), code_challenge_method: "S256", state: "st", scope: "read deploy", resource: RESOURCE });
    const auth = await h.call(h.appH, h.HOST, `/oauth/authorize?${q}`);
    expect(auth.status).toBe(302);
    const consent = new URL(auth.headers.get("location")!, ISSUER);
    expect(consent.pathname).toBe("/connect");
    const id = consent.searchParams.get("request")!;
    // 4. The page reads the request, the person approves.
    const view = await (await h.call(h.appH, h.HOST, `/v1/oauth/requests/${id}`, { cookie: h.cookie })).json() as { request: { client: { host: string } } };
    expect(view.request.client.host).toBe("claude.ai");
    const decided = await h.call(h.appH, h.HOST, `/v1/oauth/requests/${id}`, { method: "POST", cookie: h.cookie, headers: { "content-type": "application/json" }, body: JSON.stringify({ approve: true }) });
    const back = new URL(((await decided.json()) as { redirect: string }).redirect);
    expect(back.searchParams.get("state")).toBe("st");
    // 5. The client exchanges the code, form-encoded.
    const tok = await h.call(h.appH, h.HOST, "/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, client_id: CLAUDE, redirect_uri: CONNECTOR, code_verifier: verifier, resource: RESOURCE }).toString(),
    });
    expect(tok.status).toBe(200);
    expect(tok.headers.get("cache-control")).toBe("no-store");
    const t = await tok.json() as { access_token: string };
    // 6. A tool call with it works; the same token on /v1 opens nothing.
    const res = await h.toolCall(t.access_token, "status", {});
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("no previews");
    expect((await h.call(h.apiH, "api.preview.localhost:8443", "/v1/oauth/grants", { headers: { authorization: `Bearer ${t.access_token}` } })).status).toBe(401);
  });

  test("a read-only grant calling deploy gets the step-up 403: insufficient_scope, asking for deploy", async () => {
    const h = await http();
    const t = h.exchange(await h.code(h.ada, ["read"]));
    const res = await h.toolCall(t.access_token, "deploy", { image: "x", port: 80 });
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${RESOURCE}/.well-known/oauth-protected-resource", error="insufficient_scope", scope="read deploy"`);
    expect((await h.toolCall(t.access_token, "status", {})).status).toBe(200);
  });

  test("ADR-0021: a deploy grant rebuilds its own preview; someone else's steps up to update, and an update grant may", async () => {
    const h = await http();
    h.p.ctx.sources = new SourceStore(dirname(h.p.ctx.workdirs.root));
    const t = h.exchange(await h.code(h.ada, ["read", "deploy"]));
    expect(await (await h.toolCall(t.access_token, "deploy", { files: { "index.html": "v1" }, name: "mine", visibility: "public" })).text()).toContain("ready:");
    const mine = await h.toolCall(t.access_token, "deploy", { preview: "mine", files: { "index.html": "v2" } });
    expect(mine.status).toBe(200);
    expect(await mine.text()).toContain("(rebuilt)");

    // Deployed by another principal: the grant's deploy scope does not reach it.
    const tools = new Tools({ ctx: h.p.ctx, deploys: new IdempotentDeploys(h.p.ctx, new IdempotencyRepo(h.p.db, h.p.ctx.now)), logger: quiet });
    await tools.deploy({ actor: ACTOR, signal: new AbortController().signal }, { files: { "index.html": "theirs" }, name: "theirs", visibility: "public" });
    const theirs = await h.toolCall(t.access_token, "deploy", { preview: "theirs", files: { "index.html": "x" } });
    expect(theirs.status).toBe(403);
    expect(theirs.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${RESOURCE}/.well-known/oauth-protected-resource", error="insufficient_scope", scope="read deploy update"`);

    const u = h.exchange(await h.code(h.ada, ["read", "deploy", "update"]));
    const ok = await h.toolCall(u.access_token, "deploy", { preview: "theirs", files: { "index.html": "x" } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("(rebuilt)");
  });

  test("token endpoint errors are RFC 6749 JSON; a client secret is refused; JSON bodies are refused", async () => {
    const h = await http();
    const post = (body: string, type = "application/x-www-form-urlencoded") => h.call(h.appH, h.HOST, "/oauth/token", { method: "POST", headers: { "content-type": type }, body });
    let r = await post("grant_type=password");
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: "unsupported_grant_type" });
    r = await post("grant_type=refresh_token&refresh_token=gwr_nope&client_id=x");
    expect(await r.json()).toMatchObject({ error: "invalid_grant" });
    r = await post("grant_type=authorization_code&client_secret=s");
    expect(r.status).toBe(401);
    r = await post(JSON.stringify({ grant_type: "refresh_token" }), "application/json");
    expect(await r.json()).toMatchObject({ error: "invalid_request" });
  });

  test("an untrusted redirect gets an error page, never a redirect", async () => {
    const h = await http();
    const q = new URLSearchParams({ response_type: "code", client_id: CLAUDE, redirect_uri: "https://evil.example/cb", code_challenge: challengeOf(verifierFor()), code_challenge_method: "S256" });
    const r = await h.call(h.appH, h.HOST, `/oauth/authorize?${q}`);
    expect(r.status).toBe(400);
    expect(r.headers.get("location")).toBeNull();
    expect(await r.text()).toContain("did not register that redirect_uri");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
  });

  test("MCP off: every OAuth endpoint is a 404; the UI off: no resource metadata, and a 401 says only Bearer", async () => {
    const h = await http();
    h.setMcp(false);
    expect((await h.call(h.appH, h.HOST, "/.well-known/oauth-authorization-server")).status).toBe(404);
    expect((await h.call(h.appH, h.HOST, "/oauth/authorize")).status).toBe(404);
    expect((await h.call(h.appH, h.HOST, "/oauth/token", { method: "POST" })).status).toBe(404);
    h.setMcp(true);
    h.setUi(false);
    expect((await h.call(h.mcpH, "mcp.preview.localhost:8443", "/.well-known/oauth-protected-resource")).status).toBe(404);
    expect((await h.call(h.mcpH, "mcp.preview.localhost:8443", "/", { method: "POST", body: "{}" })).headers.get("www-authenticate")).toBe('Bearer realm="gangway"');
    // The API host never serves the authorization server.
    expect((await h.call(h.apiH, "api.preview.localhost:8443", "/.well-known/oauth-authorization-server")).status).toBe(404);
  });

  test("connected agents: listed on the account, revoked from it", async () => {
    const h = await http();
    const t = h.exchange(await h.code());
    const list = await (await h.call(h.appH, h.HOST, "/v1/oauth/grants", { cookie: h.cookie })).json() as { grants: { id: string }[] };
    expect(list.grants).toHaveLength(1);
    const del = await h.call(h.appH, h.HOST, `/v1/oauth/grants/${list.grants[0]!.id}`, { method: "DELETE", cookie: h.cookie });
    expect(del.status).toBe(200);
    expect((await h.toolCall(t.access_token, "status", {})).status).toBe(401);
  });
});
