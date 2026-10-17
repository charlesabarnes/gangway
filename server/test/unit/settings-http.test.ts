import { describe, expect, test } from "bun:test";
import { settingsRoutes } from "../../src/app/routes/settings.ts";
import { MemorySettingsStore, SETTINGS, Settings } from "../../src/settings.ts";
import { HOME_ORG_ID } from "../../src/db/repos/orgs.ts";
import { PASSWORD, setupAccounts } from "../helpers/accounts.ts";
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
  test("reports sources, withholds secrets, and audits only the keys a PUT changed", async () => {
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

  test.each([
    ["a config-pinned key", 409, { "github.appId": "x" }],
    ["an unknown key", 422, { nope: 1 }],
    ["a bad value", 422, { "templates.default.pr": "Not A Slug" }],
  ])("%s is %d and nothing else in the PUT is written", async (_, status, extra) => {
    const { call, ada, settings } = await make();
    const res = await call("/v1/settings", {
      method: "PUT",
      as: ada,
      json: { values: { "acme.email": "ops@example.com", ...extra } },
    });
    expect(res.status).toBe(status);
    expect(settings.get(SETTINGS.acmeEmail)).toBe("");
  });

  test("an empty PUT is 422", async () => {
    const { call, ada } = await make();
    const res = await call("/v1/settings", { method: "PUT", as: ada, json: { values: {} } });
    expect(res.status).toBe(422);
  });

  test("the env admin token may write, but surfaces.* must go through /v1/surfaces", async () => {
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

  const OIDC = {
    "auth.oidc.issuer": "https://id.example.com",
    "auth.oidc.clientId": "gangway",
    "auth.oidc.clientSecret": "s3cret-value",
  };

  test.each(Object.keys(OIDC))("passwords cannot go off while %s is empty", async (missing) => {
    const { call, ada, settings } = await make();
    const values = { ...OIDC, [missing]: "", "auth.passwords": false };
    const res = await call("/v1/settings", { method: "PUT", as: ada, json: { values } });
    expect(res.status).toBe(422);
    expect(settings.get(SETTINGS.passwordLogin)).toBe(true);
  });

  test("passwords go off with the provider set; its secret then stays", async () => {
    const { call, ada, settings } = await make();
    const put = (values: Record<string, unknown>) =>
      call("/v1/settings", { method: "PUT", as: ada, json: { values } });
    expect((await put({ ...OIDC, "auth.passwords": false })).status).toBe(200);
    expect(settings.get(SETTINGS.passwordLogin)).toBe(false);
    expect((await put({ "auth.oidc.clientSecret": "" })).status).toBe(422);
    expect((await put({ "auth.oidc.clientSecret": "", "auth.passwords": false })).status).toBe(422);
    expect(settings.get(SETTINGS.oidcClientSecret)).toBe("s3cret-value");
  });

  test("in the home org, an org's own settings are the server's and need settings.write", async () => {
    const { call, s, login, settings } = await make();
    s.roles.set("member", ["settings.org_read", "settings.org_write"], null);
    await s.accounts.createUser(
      {
        kind: "token",
        orgId: HOME_ORG_ID,
        tokenId: "system:test",
        scopes: ["admin"],
        permissions: new Set(["users.manage"]),
      } as never,
      { email: "bob@example.com", password: PASSWORD, roleId: "member" },
    );
    const bob = await login("bob@example.com");
    const view = (await (await call("/v1/settings", { as: bob })).json()) as {
      settings: { key: string; scope: string }[];
    };
    expect(view.settings.map((v) => v.key)).toContain("previews.watermark");
    expect(view.settings.every((v) => v.scope === "org")).toBe(true);
    const put = await call("/v1/settings", {
      method: "PUT",
      as: bob,
      json: { values: { "previews.watermark": false } },
    });
    expect(put.status).toBe(403);
    const password = await call("/v1/settings/preview-password", {
      method: "PUT",
      as: bob,
      json: { mode: "generated" },
    });
    expect(password.status).toBe(403);
    expect(settings.get(SETTINGS.previewWatermark)).toBe(true);
    expect(settings.get(SETTINGS.previewPasswordMode)).toBe("off");
  });
});
