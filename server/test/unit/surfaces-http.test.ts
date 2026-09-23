/**
 * §10.5 surface toggles through the real app: the lockout guard (§10.5.1), the typed phrase,
 * config pins, the audit row (§10.5.2), and the MCP drop hook.
 */
import { describe, expect, test } from "bun:test";
import { createApp, surfaceHandler } from "../../src/app/app.ts";
import { authRoutes } from "../../src/app/routes/auth.ts";
import { surfaceRoutes } from "../../src/app/routes/surfaces.ts";
import { chainVerifiers, staticTokenVerifier } from "../../src/auth/actor.ts";
import { Bootstrap } from "../../src/auth/bootstrap.ts";
import { Tokens } from "../../src/auth/tokens.ts";
import { Logger } from "../../src/logger.ts";
import { MemorySettingsStore, SETTINGS, Settings } from "../../src/settings.ts";
import { PASSWORD, setupAccounts } from "../helpers/accounts.ts";

const ENV_TOKEN = "gw_surfaces_env_token_0123456789abcdef";
const HOST = "app.preview.localhost:8443";
const PHRASE = "disable the UI";

async function make(pins: Record<string, unknown> = {}) {
  const s = setupAccounts();
  const settings = new Settings(pins, new MemorySettingsStore());
  const tokens = new Tokens(s.tokensRepo, s.roles, s.audit, s.now);
  const auth = {
    verifyToken: chainVerifiers(tokens.verify, staticTokenVerifier(ENV_TOKEN)),
    resolveSession: (secret: string) => s.sessions.resolve(secret)?.actor ?? null,
    originFor: (host: string) => `https://${host}`,
  };
  let drops = 0;
  const app = createApp({
    ...auth, logger: new Logger("error", {}, () => {}),
    v1: (api) => surfaceRoutes(api, {
      settings, audit: s.audit, hasActiveAdmin: () => s.tokensRepo.hasActiveAdmin(),
      apiOrigin: () => "https://api.preview.localhost:8443", mcpOrigin: () => "https://mcp.preview.localhost:8443",
      onMcpDisabled: () => { drops++; },
    }),
    publicV1: (pub) => authRoutes(pub, { auth, accounts: s.accounts, bootstrap: new Bootstrap(() => s.users.count()), roles: s.roles, sessionMaxAgeSec: 60 }),
  });
  const handle = surfaceHandler(app, "app");
  const call = (path: string, init: RequestInit & { json?: unknown; as?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", HOST); headers.set("origin", `https://${HOST}`);
    if (init.as?.startsWith("gw_")) headers.set("authorization", `Bearer ${init.as}`); else if (init.as) headers.set("cookie", init.as);
    if (init.json !== undefined) headers.set("content-type", "application/json");
    return Promise.resolve(handle(new Request(`https://${HOST}${path}`, { ...init, headers, ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }) }), { clientIp: "203.0.113.7" }));
  };
  const { user } = await s.admin();
  const login = async (email: string) => (await call("/v1/auth/login", { method: "POST", json: { email, password: PASSWORD } })).headers.get("set-cookie")!.split(";")[0]!;
  const ada = await login("ada@example.com");
  const adaActor = { kind: "user", userId: user.id, roleId: "admin", sessionId: "x", permissions: s.roles.for("admin") } as never;
  const put = (json: unknown, as = ada) => call("/v1/surfaces", { method: "PUT", as, json });
  return { s, settings, call, put, ada, login, tokens, adaActor, drops: () => drops };
}

describe("/v1/surfaces", () => {
  test("GET reports both surfaces, the MCP URL and the re-enable curl", async () => {
    const { call, ada } = await make();
    const res = await call("/v1/surfaces", { as: ada });
    expect(res.status).toBe(200);
    const { surfaces } = (await res.json()) as { surfaces: any };
    expect(surfaces).toMatchObject({
      ui: { enabled: true, managedByConfig: false },
      mcp: { enabled: false, managedByConfig: false, url: "https://mcp.preview.localhost:8443" },
      adminTokenExists: false,
    });
    expect(surfaces.reenableUi).toContain("curl -X PUT https://api.preview.localhost:8443/v1/surfaces");
    expect(surfaces.reenableUi).toContain(`'{"ui":true}'`);
  });

  test("MCP turns on and off with no ceremony; each change is audited with old and new; off drops in-flight sessions", async () => {
    const { put, settings, s, drops } = await make();
    expect((await put({ mcp: true })).status).toBe(200);
    expect(settings.get(SETTINGS.surfacesMcp)).toBe(true);
    expect(drops()).toBe(0);
    expect((await put({ mcp: false })).status).toBe(200);
    expect(drops()).toBe(1);
    const [off, on] = s.auditRepo.page({ limit: 2 }).entries;
    expect(on).toMatchObject({ action: "surface.changed", target: "mcp", old: { setting: "surfaces.mcp", enabled: false }, new: { setting: "surfaces.mcp", enabled: true } });
    expect(off).toMatchObject({ action: "surface.changed", target: "mcp", new: { enabled: false } });
  });

  test("a no-op PUT writes no audit row", async () => {
    const { put, s } = await make();
    const before = s.auditRepo.page({ limit: 200 }).entries.length;
    expect((await put({ ui: true, mcp: false })).status).toBe(200);
    expect(s.auditRepo.page({ limit: 200 }).entries.length).toBe(before);
  });

  test("§10.5.1: the UI stays on without the phrase, and without a live admin token", async () => {
    const { put, settings, tokens, adaActor, s } = await make();
    expect((await put({ ui: false })).status).toBe(422);
    expect((await put({ ui: false, confirm: "yes" })).status).toBe(422);

    const refused = await put({ ui: false, confirm: PHRASE });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ reason: "no_admin_token" });

    // Tokens that are NOT a way back in: a deploy-only one, an expired one, a revoked one.
    tokens.mint(adaActor, { name: "deploy only", scopes: ["deploy"] });
    tokens.mint(adaActor, { name: "short", scopes: ["admin"], expiresIn: "1h" });
    const revoked = tokens.mint(adaActor, { name: "revoked", scopes: ["admin"] });
    tokens.revoke(adaActor, revoked.token.id);
    s.clock.t += 2 * 3_600_000;
    expect((await put({ ui: false, confirm: PHRASE })).status).toBe(409);
    expect(settings.get(SETTINGS.surfacesUi)).toBe(true);

    // A mixed PUT is whole-or-nothing: MCP did not change either.
    expect((await put({ mcp: true, ui: false, confirm: PHRASE })).status).toBe(409);
    expect(settings.get(SETTINGS.surfacesMcp)).toBe(false);
  });

  test("the env admin token does not count as a way back in", async () => {
    const { put } = await make();
    expect((await put({ ui: false, confirm: PHRASE }, ENV_TOKEN)).status).toBe(409);
  });

  test("with a live admin token the UI turns off -- and back on with the bearer, as the shown curl does", async () => {
    const { put, settings, tokens, adaActor, s } = await make();
    const { secret } = tokens.mint(adaActor, { name: "break glass", scopes: ["admin"] });
    expect((await put({ ui: false, confirm: PHRASE })).status).toBe(200);
    expect(settings.get(SETTINGS.surfacesUi)).toBe(false);
    expect(s.auditRepo.page({ limit: 1 }).entries[0]).toMatchObject({ action: "surface.changed", target: "ui", old: { enabled: true }, new: { enabled: false } });
    expect((await put({ ui: true }, secret)).status).toBe(200);
    expect(settings.get(SETTINGS.surfacesUi)).toBe(true);
  });

  test("a surface pinned in config is 409 and reported as managed", async () => {
    const { put, call, ada } = await make({ "surfaces.mcp": true });
    expect((await put({ mcp: false })).status).toBe(409);
    const { surfaces } = (await (await call("/v1/surfaces", { as: ada })).json()) as { surfaces: any };
    expect(surfaces.mcp).toMatchObject({ enabled: true, managedByConfig: true });
  });

  test("needs surfaces.manage; /v1/capabilities needs only previews.read", async () => {
    const { call, s, login } = await make();
    await s.accounts.createUser({ kind: "token", tokenId: "system:test", scopes: ["admin"], permissions: new Set(["users.manage"]) } as never, { email: "vi@example.com", password: PASSWORD, roleId: "viewer" });
    const vi = await login("vi@example.com");
    expect((await call("/v1/surfaces", { as: vi })).status).toBe(403);
    expect((await call("/v1/surfaces", { method: "PUT", as: vi, json: { mcp: true } })).status).toBe(403);
    const caps = await call("/v1/capabilities", { as: vi });
    expect(caps.status).toBe(200);
    expect(await caps.json()).toEqual({ surfaces: { ui: true, mcp: false }, mcpUrl: "https://mcp.preview.localhost:8443" });
  });
});
