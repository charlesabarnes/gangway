import { describe, expect, test } from "bun:test";
import { surfaceRoutes } from "../../src/app/routes/surfaces.ts";
import { MemorySettingsStore, SETTINGS, Settings } from "../../src/settings.ts";
import { PASSWORD, setupAccounts } from "../helpers/accounts.ts";
import { signedInApp } from "../helpers/http.ts";

const ENV_TOKEN = "gw_surfaces_env_token_0123456789abcdef";
const PHRASE = "disable the UI";

async function make(pins: Record<string, unknown> = {}) {
  const s = setupAccounts();
  const settings = new Settings(pins, new MemorySettingsStore());
  let drops = 0;
  const { call, login, ada, tokens, admin } = await signedInApp(s, {
    envToken: ENV_TOKEN,
    v1: (api) =>
      surfaceRoutes(api, {
        settings,
        audit: s.audit,
        hasActiveAdmin: () => s.tokensRepo.hasActiveAdmin(),
        apiOrigin: () => "https://api.preview.localhost:8443",
        mcpOrigin: () => "https://mcp.preview.localhost:8443",
        onMcpDisabled: () => {
          drops++;
        },
      }),
  });
  const adaActor = {
    kind: "user",
    userId: admin.id,
    roleId: "admin",
    sessionId: "x",
    permissions: s.roles.for("admin"),
  } as never;
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
    expect(surfaces.reenableUi).toContain(
      "curl -X PUT https://api.preview.localhost:8443/v1/surfaces",
    );
    expect(surfaces.reenableUi).toContain(`'{"ui":true}'`);
  });

  test("MCP toggles freely, each change is audited, and turning it off drops sessions", async () => {
    const { put, settings, s, drops } = await make();
    expect((await put({ mcp: true })).status).toBe(200);
    expect(settings.get(SETTINGS.surfacesMcp)).toBe(true);
    expect(drops()).toBe(0);
    expect((await put({ mcp: false })).status).toBe(200);
    expect(drops()).toBe(1);
    const [off, on] = s.auditRepo.page({ limit: 2 }).entries;
    expect(on).toMatchObject({
      action: "surface.changed",
      target: "mcp",
      old: { setting: "surfaces.mcp", enabled: false },
      new: { setting: "surfaces.mcp", enabled: true },
    });
    expect(off).toMatchObject({
      action: "surface.changed",
      target: "mcp",
      new: { enabled: false },
    });
  });

  test("a no-op PUT writes no audit row", async () => {
    const { put, s } = await make();
    const before = s.auditRepo.page({ limit: 200 }).entries.length;
    expect((await put({ ui: true, mcp: false })).status).toBe(200);
    expect(s.auditRepo.page({ limit: 200 }).entries.length).toBe(before);
  });

  test("the UI stays on without the phrase, and without a live admin token", async () => {
    const { put, settings, tokens, adaActor, s } = await make();
    expect((await put({ ui: false })).status).toBe(422);
    expect((await put({ ui: false, confirm: "yes" })).status).toBe(422);

    const refused = await put({ ui: false, confirm: PHRASE });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ reason: "no_admin_token" });

    tokens.mint(adaActor, { name: "deploy only", scopes: ["deploy"] });
    tokens.mint(adaActor, { name: "short", scopes: ["admin"], expiresIn: "1h" });
    const revoked = tokens.mint(adaActor, { name: "revoked", scopes: ["admin"] });
    tokens.revoke(adaActor, revoked.token.id);
    s.clock.t += 2 * 3_600_000;
    expect((await put({ ui: false, confirm: PHRASE })).status).toBe(409);
    expect(settings.get(SETTINGS.surfacesUi)).toBe(true);

    expect((await put({ mcp: true, ui: false, confirm: PHRASE })).status).toBe(409);
    expect(settings.get(SETTINGS.surfacesMcp)).toBe(false);
  });

  test("the env admin token does not count as a way back in", async () => {
    const { put } = await make();
    expect((await put({ ui: false, confirm: PHRASE }, ENV_TOKEN)).status).toBe(409);
  });

  test("with a live admin token the UI turns off, and the bearer turns it back on", async () => {
    const { put, settings, tokens, adaActor, s } = await make();
    const { secret } = tokens.mint(adaActor, { name: "break glass", scopes: ["admin"] });
    expect((await put({ ui: false, confirm: PHRASE })).status).toBe(200);
    expect(settings.get(SETTINGS.surfacesUi)).toBe(false);
    expect(s.auditRepo.page({ limit: 1 }).entries[0]).toMatchObject({
      action: "surface.changed",
      target: "ui",
      old: { enabled: true },
      new: { enabled: false },
    });
    expect((await put({ ui: true }, secret)).status).toBe(200);
    expect(settings.get(SETTINGS.surfacesUi)).toBe(true);
  });

  test("a surface pinned in config is 409 and reported as managed", async () => {
    const { put, call, ada } = await make({ "surfaces.mcp": true });
    expect((await put({ mcp: false })).status).toBe(409);
    const { surfaces } = (await (await call("/v1/surfaces", { as: ada })).json()) as {
      surfaces: any;
    };
    expect(surfaces.mcp).toMatchObject({ enabled: true, managedByConfig: true });
  });

  test("needs surfaces.manage; /v1/capabilities needs only previews.read", async () => {
    const { call, s, login } = await make();
    await s.accounts.createUser(
      {
        kind: "token",
        tokenId: "system:test",
        scopes: ["admin"],
        permissions: new Set(["users.manage"]),
      } as never,
      { email: "vi@example.com", password: PASSWORD, roleId: "viewer" },
    );
    const vi = await login("vi@example.com");
    expect((await call("/v1/surfaces", { as: vi })).status).toBe(403);
    expect(
      (await call("/v1/surfaces", { method: "PUT", as: vi, json: { mcp: true } })).status,
    ).toBe(403);
    const caps = await call("/v1/capabilities", { as: vi });
    expect(caps.status).toBe(200);
    expect(await caps.json()).toEqual({
      surfaces: { ui: true, mcp: false },
      mcpUrl: "https://mcp.preview.localhost:8443",
    });
  });
});
