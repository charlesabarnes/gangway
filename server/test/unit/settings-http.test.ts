/**
 * /v1/settings through the real app: secrets never come back, a config-pinned
 * key is refused, a PUT is whole-or-nothing, and surfaces are not changed here.
 */
import { describe, expect, test } from "bun:test";
import { settingsRoutes } from "../../src/app/routes/settings.ts";
import { MemorySettingsStore, SETTINGS, Settings } from "../../src/settings.ts";
import { setupAccounts } from "../helpers/accounts.ts";
import { signedInApp } from "../helpers/http.ts";

const ENV_TOKEN = "gw_settings_env_token_0123456789abcdef";

async function make() {
  const s = setupAccounts();
  const store = new MemorySettingsStore();
  const settings = new Settings({ "github.appId": "pinned-1" }, store);
  const { call, login, ada } = await signedInApp(s, {
    envToken: ENV_TOKEN,
    v1: (api) => settingsRoutes(api, settings, s.audit),
  });
  return { s, settings, store, call, ada, login };
}

describe("/v1/settings", () => {
  test("GET reports sources and withholds secrets; PUT writes through each schema and audits keys only", async () => {
    const { call, ada, settings, s } = await make();
    let res = await call("/v1/settings", { as: ada });
    expect(res.status).toBe(200);
    let view = ((await res.json()) as { settings: any[] }).settings;
    const by = (k: string) => view.find((v) => v.key === k);
    expect(by("github.appId")).toMatchObject({
      value: "pinned-1",
      source: "config",
      managedByConfig: true,
    });
    expect(by("github.webhookSecret")).toMatchObject({ secret: true, value: null, set: false });

    res = await call("/v1/settings", {
      method: "PUT",
      as: ada,
      json: { values: { "github.webhookSecret": "hunter2", "acme.email": "ops@example.com" } },
    });
    expect(res.status).toBe(200);
    view = ((await res.json()) as { settings: any[] }).settings;
    expect(view.find((v) => v.key === "github.webhookSecret")).toMatchObject({
      secret: true,
      value: null,
      set: true,
      source: "database",
    });
    expect(view.find((v) => v.key === "acme.email")).toMatchObject({
      value: "ops@example.com",
      source: "database",
    });
    expect(settings.get(SETTINGS.githubWebhookSecret)).toBe("hunter2");

    const entry = s.auditRepo.page({ limit: 1 }).entries[0]!;
    expect(entry).toMatchObject({
      action: "settings.changed",
      new: { "github.webhookSecret": "[set]", "acme.email": "ops@example.com" },
      old: { "github.webhookSecret": "[unset]", "acme.email": "" },
    });
    expect(JSON.stringify(entry)).not.toContain("hunter2");
  });

  test("a config-pinned key is 409, an unknown key 422, a bad value 422 -- and nothing else in the PUT is written", async () => {
    const { call, ada, settings } = await make();
    let res = await call("/v1/settings", {
      method: "PUT",
      as: ada,
      json: { values: { "acme.email": "ops@example.com", "github.appId": "x" } },
    });
    expect(res.status).toBe(409);
    expect(settings.get(SETTINGS.acmeEmail)).toBe("");
    res = await call("/v1/settings", {
      method: "PUT",
      as: ada,
      json: { values: { "acme.email": "ops@example.com", nope: 1 } },
    });
    expect(res.status).toBe(422);
    res = await call("/v1/settings", {
      method: "PUT",
      as: ada,
      json: { values: { "acme.email": "ops@example.com", "templates.default.pr": "Not A Slug" } },
    });
    expect(res.status).toBe(422);
    expect(settings.get(SETTINGS.acmeEmail)).toBe("");
    res = await call("/v1/settings", { method: "PUT", as: ada, json: { values: {} } });
    expect(res.status).toBe(422);
  });

  test("the env admin token may write; surfaces.* are refused here, even to it: they go through /v1/surfaces", async () => {
    const { call } = await make();
    expect(
      (
        await call("/v1/settings", {
          method: "PUT",
          as: ENV_TOKEN,
          json: { values: { "acme.email": "ops@example.com" } },
        })
      ).status,
    ).toBe(200);
    const refused = await call("/v1/settings", {
      method: "PUT",
      as: ENV_TOKEN,
      json: { values: { "surfaces.ui": false } },
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { detail: string }).detail).toContain("/v1/surfaces");
  });
});
