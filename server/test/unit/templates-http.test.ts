/** /v1/templates, the trigger defaults in /v1/settings, and a repository's templateId, through the real app. */
import { describe, expect, test } from "bun:test";
import { projectRoutes } from "../../src/app/routes/projects.ts";
import { settingsRoutes } from "../../src/app/routes/settings.ts";
import { templateRoutes } from "../../src/app/routes/templates.ts";
import { HostsRepo, ProjectsRepo, TemplatesRepo } from "../../src/db/repos/index.ts";
import { MemorySettingsStore, SETTINGS, Settings } from "../../src/settings.ts";
import { TRIGGERS } from "@gangway/shared/domain";
import { PASSWORD, setupAccounts } from "../helpers/accounts.ts";
import { signedInApp } from "../helpers/http.ts";

const ENV_TOKEN = "gw_templates_env_token_0123456789abcd";

async function make() {
  const s = setupAccounts();
  const settings = new Settings({}, new MemorySettingsStore());
  const repos = new ProjectsRepo(s.db, s.now);
  const templates = new TemplatesRepo(s.db, s.now);
  const hosts = new HostsRepo(s.db, s.now);
  hosts.upsert({
    id: "local",
    name: "local",
    dockerHost: "unix:///var/run/docker.sock",
    expectName: null,
    capabilities: ["preview"],
    publishBind: "127.0.0.1",
    upstream: { dial: "direct", address: "127.0.0.1", proxy: null },
    ports: { rangeStart: 31000, rangeEnd: 31499 },
  });
  const triggerDefault = (t: string) =>
    settings.get(
      t === "pr"
        ? SETTINGS.templatePr
        : t === "api"
          ? SETTINGS.templateApi
          : SETTINGS.templateManual,
    );
  const { call, login, ada } = await signedInApp(s, {
    envToken: ENV_TOKEN,
    v1: (api) => {
      templateRoutes(api, {
        templates,
        hosts,
        audit: s.audit,
        namedByTrigger: (id) => TRIGGERS.filter((t) => triggerDefault(t) === id),
      });
      settingsRoutes(api, settings, s.audit, templates);
      projectRoutes(api, { projects: repos, audit: s.audit, templates });
    },
  });
  return { s, settings, repos, templates, call, ada, login };
}

describe("/v1/templates", () => {
  test("every install has `default`; create starts from it, edit is partial, the list puts the built-in first", async () => {
    const { call, ada, s } = await make();
    let res = await call("/v1/templates", { as: ada });
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { templates: { id: string; builtin: boolean; ttl: string }[] })
        .templates,
    ).toMatchObject([
      {
        id: "default",
        builtin: true,
        ttl: "7d",
        visibility: "unlisted",
        idleAfter: "30m",
        clearance: "standard",
        hostId: null,
      },
    ]);

    res = await call("/v1/templates", {
      method: "POST",
      as: ada,
      json: {
        id: "staging",
        name: "Staging",
        visibility: "private",
        clearance: "high",
        hostId: "local",
      },
    });
    expect(res.status).toBe(201);
    const { template } = (await res.json()) as { template: Record<string, unknown> };
    // Unsaid fields come from `default`, not from hard-coded constants.
    expect(template).toMatchObject({
      id: "staging",
      name: "Staging",
      builtin: false,
      visibility: "private",
      clearance: "high",
      hostId: "local",
      ttl: "7d",
      idleAfter: "30m",
      description: "",
    });

    res = await call("/v1/templates/staging", {
      method: "PATCH",
      as: ada,
      json: { ttl: null, idleAfter: "never" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { template: Record<string, unknown> }).template).toMatchObject({
      ttl: null,
      idleAfter: "never",
      visibility: "private",
    });

    res = await call("/v1/templates", { as: ada });
    expect(
      ((await res.json()) as { templates: { id: string }[] }).templates.map((t) => t.id),
    ).toEqual(["default", "staging"]);
    expect(s.actions().filter((a) => a.startsWith("template."))).toEqual([
      "template.created",
      "template.updated",
    ]);
  });

  test("what the schema cannot say: a duration that does not parse, a host that does not exist, an id already taken, an id that is not a slug", async () => {
    const { call, ada } = await make();
    expect(
      (
        await call("/v1/templates", {
          method: "POST",
          as: ada,
          json: { id: "x", name: "x", ttl: "soon" },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("/v1/templates", {
          method: "POST",
          as: ada,
          json: { id: "x", name: "x", idleAfter: "later" },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("/v1/templates", {
          method: "POST",
          as: ada,
          json: { id: "x", name: "x", hostId: "mars" },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("/v1/templates", {
          method: "POST",
          as: ada,
          json: { id: "Not A Slug", name: "x" },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("/v1/templates", {
          method: "POST",
          as: ada,
          json: { id: "default", name: "again" },
        })
      ).status,
    ).toBe(409);
    expect(
      (await call("/v1/templates/default", { method: "PATCH", as: ada, json: { id: "renamed" } }))
        .status,
    ).toBe(422); // strict: no such field
    expect(
      (await call("/v1/templates/ghost", { method: "PATCH", as: ada, json: { name: "x" } })).status,
    ).toBe(404);
  });

  test("delete: never the built-in one, never one a trigger default names; a repository on a deleted template falls back", async () => {
    const { call, ada, settings, repos } = await make();
    expect((await call("/v1/templates/default", { method: "DELETE", as: ada })).status).toBe(409);
    await call("/v1/templates", {
      method: "POST",
      as: ada,
      json: { id: "staging", name: "Staging" },
    });

    // A trigger default must exist to be set, and pins the template while it does.
    expect(
      (
        await call("/v1/settings", {
          method: "PUT",
          as: ada,
          json: { values: { "templates.default.api": "ghost" } },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("/v1/settings", {
          method: "PUT",
          as: ada,
          json: { values: { "templates.default.api": "staging" } },
        })
      ).status,
    ).toBe(200);
    expect(settings.get(SETTINGS.templateApi)).toBe("staging");
    const refused = await call("/v1/templates/staging", { method: "DELETE", as: ada });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ triggers: ["api"] });
    await call("/v1/settings", {
      method: "PUT",
      as: ada,
      json: { values: { "templates.default.api": "default" } },
    });

    const repo = repos.create({
      id: "r1",
      name: "web",
      forge: "github",
      fullName: "acme/web",
      installationId: "1",
      slug: "web",
    });
    expect(
      (
        await call(`/v1/projects/${repo.id}`, {
          method: "PATCH",
          as: ada,
          json: { templateId: "ghost" },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call(`/v1/projects/${repo.id}`, {
          method: "PATCH",
          as: ada,
          json: { templateId: "staging", prClearance: null },
        })
      ).status,
    ).toBe(200);
    expect(repos.get(repo.id)).toMatchObject({ templateId: "staging", prClearance: null });

    expect((await call("/v1/templates/staging", { method: "DELETE", as: ada })).status).toBe(204);
    expect(repos.get(repo.id)!.templateId).toBeNull();
    expect((await call("/v1/templates/staging", { as: ada })).status).toBe(404);
  });

  test("permissions: previews.read lists, templates.manage changes, repos.manage tunes a repository", async () => {
    const { call, ada, s, login, repos } = await make();
    s.roles.set("member", ["previews.read"], null);
    await s.accounts.createUser(
      {
        kind: "token",
        tokenId: "system:test",
        scopes: ["admin"],
        permissions: new Set(["users.manage"]),
      } as never,
      { email: "bob@example.com", password: PASSWORD, roleId: "member" },
    );
    const bob = await login("bob@example.com");
    const repo = repos.create({
      id: "r1",
      name: "web",
      forge: "github",
      fullName: "acme/web",
      installationId: "1",
      slug: "web",
    });
    expect((await call("/v1/templates", { as: bob })).status).toBe(200);
    expect(
      (await call("/v1/templates", { method: "POST", as: bob, json: { id: "x", name: "x" } }))
        .status,
    ).toBe(403);
    expect(
      (
        await call(`/v1/projects/${repo.id}`, {
          method: "PATCH",
          as: bob,
          json: { templateId: "default" },
        })
      ).status,
    ).toBe(403);
    s.roles.set("member", ["previews.read", "templates.manage", "repos.manage"], null);
    expect(
      (await call("/v1/templates", { method: "POST", as: bob, json: { id: "x", name: "x" } }))
        .status,
    ).toBe(201);
    expect(
      (
        await call(`/v1/projects/${repo.id}`, {
          method: "PATCH",
          as: bob,
          json: { templateId: "x" },
        })
      ).status,
    ).toBe(200);
    void ada;
  });
});
