/** /v1/github (the manifest flow) and /v1/repos through the real app. */
import { describe, expect, test } from "bun:test";
import { githubRoutes } from "../../src/app/routes/github.ts";
import { projectRoutes } from "../../src/app/routes/projects.ts";
import { randomBytes } from "node:crypto";
import { ProjectsRepo } from "../../src/db/repos/projects.ts";
import { SecretBox } from "../../src/secrets/box.ts";
import { Secrets } from "../../src/secrets/secrets.ts";
import { secretRoutes } from "../../src/app/routes/secrets.ts";
import { GitHubApp } from "../../src/forge/github/app.ts";
import { ManifestStates } from "../../src/forge/github/manifest.ts";
import { MemorySettingsStore, SETTINGS, Settings } from "../../src/settings.ts";
import { setupAccounts } from "../helpers/accounts.ts";
import { silentLogger } from "../helpers/logger.ts";
import { signedInApp } from "../helpers/http.ts";

const ENV_TOKEN = "gw_github_env_token_0123456789abcdef";

async function make(o: { overrides?: Record<string, unknown>; conversion?: number } = {}) {
  const s = setupAccounts();
  const settings = new Settings(o.overrides ?? {}, new MemorySettingsStore());
  const repos = new ProjectsRepo(s.db, s.now);
  const conversions: string[] = [];
  const app = new GitHubApp({
    credentials: () => ({ appId: "", privateKey: "" }),
    baseUrl: "https://api.github.test",
    log: silentLogger(),
    fetch: async (url, init) => {
      const m = /\/app-manifests\/([^/]+)\/conversions$/.exec(url);
      if (m && init?.method === "POST") {
        conversions.push(m[1]!);
        if (o.conversion === 404)
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        return new Response(
          JSON.stringify({
            id: 777,
            slug: "gangway-preview",
            client_id: "Iv1.abc",
            client_secret: "cs_secret",
            webhook_secret: "wh_secret",
            pem: "-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----\n",
            html_url: "https://github.com/apps/gangway-preview",
          }),
          { status: 201 },
        );
      }
      return new Response("{}", { status: 404 });
    },
  });
  let clock = 1_700_000_000_000;
  const states = new ManifestStates(() => clock);
  const { call, ada } = await signedInApp(s, {
    envToken: ENV_TOKEN,
    v1: (api) => {
      const secrets = new Secrets(
        repos,
        new MemorySettingsStore(),
        new SecretBox(randomBytes(32)),
        s.audit,
      );
      projectRoutes(api, { projects: repos, audit: s.audit, secrets });
      secretRoutes(api, secrets);
      githubRoutes(api, {
        app,
        settings,
        states,
        audit: s.audit,
        baseDomain: () => "preview.localhost",
        originFor: (l) => `https://${l}.preview.localhost:8443`,
      });
    },
  });
  return {
    s,
    settings,
    repos,
    call,
    ada,
    conversions,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("/v1/github", () => {
  test("status: not configured, with what is missing and where the webhook would go", async () => {
    const { call, ada } = await make();
    const res = await call("/v1/github", { as: ada });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      configured: false,
      appId: "",
      appSlug: "",
      appUrl: null,
      installUrl: null,
      webhookUrl: "https://hooks.preview.localhost:8443/github",
      missing: ["github.appId", "github.privateKey", "github.webhookSecret"],
      managedByConfig: false,
    });
  });

  test("the manifest flow: manifest + state, then the code becomes the credentials -- stored, audited as [set], never returned", async () => {
    const t = await make();
    const m = await t.call("/v1/github/manifest", { as: t.ada });
    expect(m.status).toBe(200);
    const { action, manifest, state } = (await m.json()) as any;
    expect(action).toBe(`https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`);
    expect(manifest).toMatchObject({
      url: "https://app.preview.localhost:8443",
      redirect_url: "https://app.preview.localhost:8443/github/callback",
      hook_attributes: { url: "https://hooks.preview.localhost:8443/github", active: true },
      public: false,
      default_permissions: {
        contents: "read",
        metadata: "read",
        issues: "read",
        pull_requests: "write",
        deployments: "write",
      },
      default_events: ["pull_request", "issue_comment"],
    });

    const ex = await t.call("/v1/github/manifest/exchange", {
      method: "POST",
      as: t.ada,
      json: { code: "one-time-code", state },
    });
    expect(ex.status).toBe(201);
    const status = (await ex.json()) as any;
    expect(status).toMatchObject({
      configured: true,
      appId: "777",
      appSlug: "gangway-preview",
      installUrl: "https://github.com/apps/gangway-preview/installations/new",
      missing: [],
    });
    expect(JSON.stringify(status)).not.toMatch(/cs_secret|wh_secret|BEGIN RSA/);
    expect(t.conversions).toEqual(["one-time-code"]);
    expect(t.settings.get(SETTINGS.githubPrivateKey)).toContain("BEGIN RSA PRIVATE KEY");
    expect(t.settings.get(SETTINGS.githubWebhookSecret)).toBe("wh_secret");
    const entry = t.s.auditRepo.page({ limit: 1 }).entries[0]!;
    expect(entry).toMatchObject({
      action: "github.connected",
      target: "777",
      new: { slug: "gangway-preview", privateKey: "[redacted]", webhookSecret: "[redacted]" },
    });
    expect(JSON.stringify(entry)).not.toMatch(/cs_secret|wh_secret/);

    // The state was consumed.
    expect(
      (
        await t.call("/v1/github/manifest/exchange", {
          method: "POST",
          as: t.ada,
          json: { code: "again", state },
        })
      ).status,
    ).toBe(422);
  });

  test("an unknown or expired state is 422 and GitHub is never called; a used code is 422 too", async () => {
    const t = await make({ conversion: 404 });
    expect(
      (
        await t.call("/v1/github/manifest/exchange", {
          method: "POST",
          as: t.ada,
          json: { code: "c", state: "made-up" },
        })
      ).status,
    ).toBe(422);
    expect(t.conversions).toEqual([]);
    const { state } = (await (await t.call("/v1/github/manifest", { as: t.ada })).json()) as any;
    t.advance(11 * 60_000);
    expect(
      (
        await t.call("/v1/github/manifest/exchange", {
          method: "POST",
          as: t.ada,
          json: { code: "c", state },
        })
      ).status,
    ).toBe(422);
    expect(t.conversions).toEqual([]);
    const { state: fresh } = (await (
      await t.call("/v1/github/manifest", { as: t.ada })
    ).json()) as any;
    expect(
      (
        await t.call("/v1/github/manifest/exchange", {
          method: "POST",
          as: t.ada,
          json: { code: "used", state: fresh },
        })
      ).status,
    ).toBe(422);
    expect(t.conversions).toEqual(["used"]);
  });

  test("with the App pinned from the environment the manifest flow is a 409 and status says managedByConfig", async () => {
    const t = await make({
      overrides: { "github.appId": "1", "github.privateKey": "k", "github.webhookSecret": "s" },
    });
    expect((await (await t.call("/v1/github", { as: t.ada })).json()) as any).toMatchObject({
      configured: true,
      managedByConfig: true,
      missing: [],
    });
    expect((await t.call("/v1/github/manifest", { as: t.ada })).status).toBe(409);
  });
});
