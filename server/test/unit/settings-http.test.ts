/**
 * /v1/settings through the real app (ADR-0011): secrets never come back, a config-pinned
 * key is refused, a PUT is whole-or-nothing, and surfaces are not changed here.
 */
import { describe, expect, test } from "bun:test";
import { createApp, surfaceHandler } from "../../src/app/app.ts";
import { authRoutes } from "../../src/app/routes/auth.ts";
import { settingsRoutes } from "../../src/app/routes/settings.ts";
import { chainVerifiers, staticTokenVerifier } from "../../src/auth/actor.ts";
import { Bootstrap } from "../../src/auth/bootstrap.ts";
import { Tokens } from "../../src/auth/tokens.ts";
import { Logger } from "../../src/logger.ts";
import { MemorySettingsStore, SETTINGS, Settings } from "../../src/settings.ts";
import { PASSWORD, setupAccounts } from "../helpers/accounts.ts";

const ENV_TOKEN = "gw_settings_env_token_0123456789abcdef";
const HOST = "app.preview.localhost:8443";

async function make() {
  const s = setupAccounts();
  const store = new MemorySettingsStore();
  const settings = new Settings({ "github.appId": "pinned-1" }, store);
  const tokens = new Tokens(s.tokensRepo, s.roles, s.audit, s.now);
  const auth = {
    verifyToken: chainVerifiers(tokens.verify, staticTokenVerifier(ENV_TOKEN)),
    resolveSession: (secret: string) => s.sessions.resolve(secret)?.actor ?? null,
    originFor: (host: string) => `https://${host}`,
  };
  const app = createApp({
    ...auth, logger: new Logger("error", {}, () => {}),
    v1: (api) => settingsRoutes(api, settings, s.audit),
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
  await s.admin();
  const login = async (email: string) => (await call("/v1/auth/login", { method: "POST", json: { email, password: PASSWORD } })).headers.get("set-cookie")!.split(";")[0]!;
  const ada = await login("ada@example.com");
  return { s, settings, store, call, ada, login };
}

describe("/v1/settings", () => {
  test("GET reports sources and withholds secrets; PUT writes through each schema and audits keys only", async () => {
    const { call, ada, settings, s } = await make();
    let res = await call("/v1/settings", { as: ada });
    expect(res.status).toBe(200);
    let view = ((await res.json()) as { settings: any[] }).settings;
    const by = (k: string) => view.find((v) => v.key === k);
    expect(by("github.appId")).toMatchObject({ value: "pinned-1", source: "config", managedByConfig: true });
    expect(by("github.webhookSecret")).toMatchObject({ secret: true, value: null, set: false });

    res = await call("/v1/settings", { method: "PUT", as: ada, json: { values: { "github.webhookSecret": "hunter2", "acme.email": "ops@example.com" } } });
    expect(res.status).toBe(200);
    view = ((await res.json()) as { settings: any[] }).settings;
    expect(view.find((v) => v.key === "github.webhookSecret")).toMatchObject({ secret: true, value: null, set: true, source: "database" });
    expect(view.find((v) => v.key === "acme.email")).toMatchObject({ value: "ops@example.com", source: "database" });
    expect(settings.get(SETTINGS.githubWebhookSecret)).toBe("hunter2");

    const entry = s.auditRepo.page({ limit: 1 }).entries[0]!;
    expect(entry).toMatchObject({ action: "settings.changed", new: { "github.webhookSecret": "[set]", "acme.email": "ops@example.com" }, old: { "github.webhookSecret": "[unset]", "acme.email": "" } });
    expect(JSON.stringify(entry)).not.toContain("hunter2");
  });

  test("a config-pinned key is 409, an unknown key 422, a bad value 422 -- and nothing else in the PUT is written", async () => {
    const { call, ada, settings } = await make();
    let res = await call("/v1/settings", { method: "PUT", as: ada, json: { values: { "acme.email": "ops@example.com", "github.appId": "x" } } });
    expect(res.status).toBe(409);
    expect(settings.get(SETTINGS.acmeEmail)).toBe("");
    res = await call("/v1/settings", { method: "PUT", as: ada, json: { values: { "acme.email": "ops@example.com", "nope": 1 } } });
    expect(res.status).toBe(422);
    res = await call("/v1/settings", { method: "PUT", as: ada, json: { values: { "acme.email": "ops@example.com", "templates.default.pr": "Not A Slug" } } });
    expect(res.status).toBe(422);
    expect(settings.get(SETTINGS.acmeEmail)).toBe("");
    res = await call("/v1/settings", { method: "PUT", as: ada, json: { values: {} } });
    expect(res.status).toBe(422);
  });

  test("the env admin token may write; surfaces.* are refused here, even to it: they go through /v1/surfaces", async () => {
    const { call } = await make();
    expect((await call("/v1/settings", { method: "PUT", as: ENV_TOKEN, json: { values: { "acme.email": "ops@example.com" } } })).status).toBe(200);
    const refused = await call("/v1/settings", { method: "PUT", as: ENV_TOKEN, json: { values: { "surfaces.ui": false } } });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { detail: string }).detail).toContain("/v1/surfaces");
  });
});
