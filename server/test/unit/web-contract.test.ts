// The server's half of the UI contract; web/src/app/core/api.types.spec.ts is the other.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { DISABLE_UI_PHRASE, PREVIEW_STATE_VALUES, VISIBILITY_VALUES } from "@gangway/shared/api";
import { CLEARANCES, TRIGGERS } from "@gangway/shared/domain";
import { ALL_PERMISSIONS, SCOPES, SCOPE_PERMISSIONS } from "@gangway/shared/permissions";
import { createApp, surfaceHandler } from "../../src/app/app.ts";
import type { AppEnv } from "../../src/app/env.ts";
import { errorHandler } from "../../src/app/problem.ts";
import { authRoutes } from "../../src/app/routes/auth.ts";
import { githubRoutes } from "../../src/app/routes/github.ts";
import { projectRoutes } from "../../src/app/routes/projects.ts";
import { templateRoutes } from "../../src/app/routes/templates.ts";
import { previewRoutes } from "../../src/app/routes/previews.ts";
import { tokenRoutes } from "../../src/app/routes/tokens.ts";
import { surfaceRoutes } from "../../src/app/routes/surfaces.ts";
import { oauthRoutes } from "../../src/app/routes/oauth.ts";
import { OAuthServer } from "../../src/oauth/server.ts";
import { OAuthGrantsRepo } from "../../src/db/repos/oauth-grants.ts";
import { createHash } from "node:crypto";
import { staticTokenVerifier } from "../../src/auth/actor.ts";
import { Bootstrap } from "../../src/auth/bootstrap.ts";
import { Tokens } from "../../src/auth/tokens.ts";
import { ProjectsRepo } from "../../src/db/repos/projects.ts";
import { TemplatesRepo } from "../../src/db/repos/templates.ts";
import { ManifestStates } from "../../src/forge/github/manifest.ts";
import { MemorySettingsStore, SETTINGS, Settings } from "../../src/settings.ts";
import { LOG_STREAMS } from "../../src/previews/logs.ts";
import { PASSWORD, setupAccounts } from "../helpers/accounts.ts";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";
import { silentLogger } from "../helpers/logger.ts";

const contract = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../web/src/testing/fixtures/contract.json"), "utf8"),
) as Record<string, unknown>;
const quiet = silentLogger();

// Keys and value types, recursively; an array is the shape of its first element.
function shapeOf(v: unknown): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length === 0 ? [] : [shapeOf(v[0])];
  if (typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, shapeOf(x)]),
    );
  return typeof v;
}

describe("string unions the UI switches on", () => {
  test("preview states, visibilities, log streams, scopes", () => {
    expect(contract["previewStates"]).toEqual([...PREVIEW_STATE_VALUES]);
    expect(contract["visibilities"]).toEqual([...VISIBILITY_VALUES]);
    expect(contract["logStreams"]).toEqual([...LOG_STREAMS]);
    expect(contract["scopes"]).toEqual([...SCOPES]);
  });

  test("what each token scope grants", () => {
    const sorted = (o: Record<string, readonly string[]>) =>
      Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [...v].sort()]));
    expect(sorted(contract["scopePermissions"] as Record<string, string[]>)).toEqual(
      sorted(SCOPE_PERMISSIONS),
    );
  });

  test("the permission ids the UI gates on are exactly the catalogue", () => {
    expect([...(contract["permissions"] as string[])].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });
});

describe("preview wire shapes", () => {
  const api = (s: ReturnType<typeof setupPreviewContext>) => {
    const app = new Hono<AppEnv>();
    app.onError(errorHandler(quiet));
    app.use(async (c, next) => {
      c.set("requestId", "r");
      c.set("actor", ACTOR);
      return next();
    });
    previewRoutes(app, s.ctx, null as never);
    return app;
  };

  test("a preview, the list envelope, and a history event", async () => {
    const s = setupPreviewContext();
    const p = await s.deployed("contract");
    const app = api(s);
    const detail = (await (await app.request(`/previews/${p.id}`)).json()) as { preview: unknown };
    expect(shapeOf(detail.preview)).toEqual(shapeOf(contract["preview"]));

    const list = (await (await app.request("/previews")).json()) as {
      seq: number;
      previews: unknown[];
    };
    expect(Object.keys(list).sort()).toEqual(Object.keys(contract["previewList"] as object).sort());
    expect(shapeOf(list.previews[0])).toEqual(shapeOf(contract["preview"]));

    const { events } = (await (await app.request(`/previews/${p.id}/events`)).json()) as {
      events: { type: string }[];
    };
    expect(shapeOf(events.find((e) => e.type === "preview.state"))).toEqual(
      shapeOf(contract["previewEvent"]),
    );
  });

  test("every event type the server publishes to the stream is one the UI listens for", async () => {
    const s = setupPreviewContext();
    await s.deployed("types");
    const published = new Set(s.ctx.bus.history(s.previews.list()[0]!.id).map((e) => e.type));
    for (const type of published) expect(contract["streamEventTypes"]).toContain(type);
    expect(contract["streamEventTypes"]).toContain("reset");
  });
});

describe("account wire shapes", () => {
  test("an anonymous and a signed-in session, login, a token, and a problem", async () => {
    const s = setupAccounts();
    const tokens = new Tokens(s.tokensRepo, s.roles, s.audit, s.now);
    const auth = {
      verifyToken: staticTokenVerifier("gw_contract_env_token_0123456789abcd"),
      resolveSession: (x: string) => s.sessions.resolve(x)?.actor ?? null,
      originFor: (h: string) => `https://${h}`,
    };
    const app = createApp({
      ...auth,
      logger: quiet,
      v1: (a) => tokenRoutes(a, tokens),
      publicV1: (pub) =>
        authRoutes(pub, {
          auth,
          accounts: s.accounts,
          bootstrap: new Bootstrap(() => s.users.count()),
          roles: s.roles,
          sessionMaxAgeSec: 60,
        }),
    });
    const h = surfaceHandler(app, "app");
    const HOST = "app.preview.localhost";
    const call = (path: string, init: RequestInit = {}) =>
      Promise.resolve(
        h(
          new Request(`https://${HOST}${path}`, {
            ...init,
            headers: {
              host: HOST,
              origin: `https://${HOST}`,
              "content-type": "application/json",
              ...(init.headers as Record<string, string> | undefined),
            },
          }),
          { clientIp: "::1" },
        ),
      );

    expect(shapeOf(await (await call("/v1/auth/session")).json())).toEqual(
      shapeOf(contract["sessionAnonymous"]),
    );

    await s.admin();
    const login = await call("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "ada@example.com", password: PASSWORD }),
    });
    expect(shapeOf(await login.json())).toEqual(shapeOf(contract["login"]));
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect(shapeOf(await (await call("/v1/auth/session", { headers: { cookie } })).json())).toEqual(
      shapeOf(contract["sessionUser"]),
    );

    const minted = (await (
      await call("/v1/tokens", {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({ name: "ci", scopes: ["deploy"] }),
      })
    ).json()) as { token: unknown };
    expect(shapeOf(minted.token)).toEqual(shapeOf(contract["token"]));

    const denied = await call("/v1/tokens", { headers: { authorization: "Bearer gw_nope" } });
    expect(Object.keys((await denied.json()) as object).sort()).toEqual(
      Object.keys(contract["problem"] as object).sort(),
    );
  });
});

describe("surface wire shapes", () => {
  test("GET /v1/surfaces, GET /v1/capabilities, and the phrase", async () => {
    const settings = new Settings({}, new MemorySettingsStore());
    const api = new Hono<AppEnv>();
    api.onError(errorHandler(quiet));
    api.use(async (c, next) => {
      c.set("actor", ACTOR);
      await next();
    });
    surfaceRoutes(api, {
      settings,
      audit: { record() {} },
      hasActiveAdmin: () => false,
      apiOrigin: () => "https://api.preview.localhost:8443",
      mcpOrigin: () => "https://mcp.preview.localhost:8443",
    });
    const { surfaces } = (await (await api.request("/surfaces")).json()) as { surfaces: unknown };
    expect(shapeOf(surfaces)).toEqual(shapeOf(contract["surfaces"]));
    expect(surfaces).toEqual(contract["surfaces"]);
    expect(shapeOf(await (await api.request("/capabilities")).json())).toEqual(
      shapeOf(contract["capabilities"]),
    );
    expect(contract["disableUiPhrase"]).toBe(DISABLE_UI_PHRASE);
  });
});

describe("oauth wire shapes", () => {
  test("the consent view, the decision, and a connected agent", async () => {
    const s = setupAccounts();
    const { user } = await s.admin();
    const CLIENT = "https://claude.ai/oauth/claude-code-client-metadata",
      CB = "https://claude.ai/api/mcp/auth_callback";
    const oauth = new OAuthServer({
      grants: new OAuthGrantsRepo(s.db, s.now),
      roles: s.roles,
      audit: s.audit,
      now: s.now,
      issuer: () => "https://app.preview.localhost:8443",
      resource: () => "https://mcp.preview.localhost:8443",
      clients: { get: async (id) => ({ clientId: id, clientName: "Claude", redirectUris: [CB] }) },
    });
    const actor = {
      kind: "user",
      userId: user.id,
      roleId: "admin",
      sessionId: "s",
      permissions: s.roles.for("admin"),
    } as const;
    const api = new Hono<AppEnv>();
    api.onError(errorHandler(quiet));
    api.use(async (c, next) => {
      c.set("actor", actor);
      await next();
    });
    oauthRoutes(api, { oauth, enabled: () => true });
    const verifier = "v".repeat(43);
    const out = await oauth.authorize(
      new URLSearchParams({
        response_type: "code",
        client_id: CLIENT,
        redirect_uri: CB,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        state: "xyz",
      }),
    );
    const id = (out as { requestId: string }).requestId;
    const view = (await (await api.request(`/oauth/requests/${id}`)).json()) as {
      request: unknown;
    };
    expect(shapeOf(view.request)).toEqual(shapeOf(contract["oauthRequest"]));
    const decided = (await (
      await api.request(`/oauth/requests/${id}`, {
        method: "POST",
        body: JSON.stringify({ approve: true }),
        headers: { "content-type": "application/json" },
      })
    ).json()) as { redirect: string };
    expect(shapeOf(decided)).toEqual(shapeOf(contract["oauthDecided"]));
    oauth.token(
      new URLSearchParams({
        grant_type: "authorization_code",
        code: new URL(decided.redirect).searchParams.get("code")!,
        client_id: CLIENT,
        redirect_uri: CB,
        code_verifier: verifier,
      }),
    );
    const { grants } = (await (await api.request("/oauth/grants")).json()) as { grants: unknown[] };
    expect(shapeOf(grants[0])).toEqual(shapeOf(contract["oauthGrant"]));
  });
});

describe("github wire shapes", () => {
  test("the status and a repository", async () => {
    const s = setupAccounts();
    const settings = new Settings({}, new MemorySettingsStore());
    settings.set(SETTINGS.githubAppId, "777");
    settings.set(SETTINGS.githubAppSlug, "gangway-preview");
    settings.set(SETTINGS.githubPrivateKey, "k");
    settings.set(SETTINGS.githubWebhookSecret, "s");
    const repos = new ProjectsRepo(s.db, s.now);
    repos.create({
      id: "r1",
      name: "web",
      forge: "github",
      fullName: "acme/web-app",
      installationId: "4242",
      slug: "web-app",
    });
    const app = new Hono<AppEnv>();
    app.onError(errorHandler(quiet));
    app.use(async (c, next) => {
      c.set("requestId", "r");
      c.set("actor", ACTOR);
      return next();
    });
    const templates = new TemplatesRepo(s.db, s.now);
    projectRoutes(app, { projects: repos, audit: s.audit, templates });
    templateRoutes(app, {
      templates,
      hosts: { get: () => undefined },
      audit: s.audit,
      namedByTrigger: () => [],
    });
    githubRoutes(app, {
      app: null as never,
      settings,
      states: new ManifestStates(),
      audit: s.audit,
      baseDomain: () => "preview.localhost",
      originFor: (l) => `https://${l}.preview.localhost:8443`,
    });

    expect(shapeOf(await (await app.request("/github")).json())).toEqual(
      shapeOf(contract["githubStatus"]),
    );
    const { project } = (await (await app.request("/projects/r1")).json()) as { project: unknown };
    expect(shapeOf(project)).toEqual(shapeOf(contract["project"]));
    repos.create({ id: "r2", name: "whoami", slug: "whoami" });
    const bare = (
      (await (await app.request("/projects/whoami")).json()) as { project: Record<string, unknown> }
    ).project;
    expect(Object.keys(bare).sort()).toEqual(Object.keys(contract["project"] as object).sort());
    expect(bare).toMatchObject({ forge: null, fullName: null });
    expect(contract["forkPolicies"]).toEqual(["ask", "auto", "never"]);
    expect(contract["clearances"]).toEqual([...CLEARANCES]);
    const { template } = (await (await app.request("/templates/default")).json()) as {
      template: unknown;
    };
    expect(shapeOf(template)).toEqual(shapeOf(contract["template"]));
    expect(contract["triggers"]).toEqual([...TRIGGERS]);
  });
});

describe("runtime wire shapes", () => {
  test("the catalogue, a plan, a kept source, a redeploy, and the runtime ids", async () => {
    const { SourceStore } = await import("../../src/previews/source/store.ts");
    const { runtimeRoutes } = await import("../../src/app/routes/runtimes.ts");
    const { deploy } = await import("../../src/previews/deploy.ts");
    const { RUNTIME_IDS } = await import("@gangway/shared/runtimes");
    const { pack } = await import("tar-stream");
    const { gzipSync } = await import("node:zlib");
    const { dirname } = await import("node:path");
    const s = setupPreviewContext();
    s.ctx.sources = new SourceStore(dirname(s.ctx.workdirs.root));
    const app = new Hono<AppEnv>();
    app.onError(errorHandler(quiet));
    app.use(async (c, next) => {
      c.set("requestId", "r");
      c.set("actor", ACTOR);
      return next();
    });
    previewRoutes(app, s.ctx, null as never);
    runtimeRoutes(app);

    expect(contract["runtimeIds"]).toEqual([...RUNTIME_IDS]);
    const list = (await (await app.request("/runtimes")).json()) as {
      runtimes: unknown[];
      detection: unknown[];
    };
    const want = contract["runtimeList"] as { runtimes: unknown[]; detection: unknown[] };
    expect(Object.keys(list).sort()).toEqual(Object.keys(want).sort());
    // Starter maps differ per runtime, so only their presence is compared.
    const noStarter = (r: unknown) => {
      const { starter, ...rest } = r as Record<string, unknown>;
      return shapeOf({ ...rest, starterIsObject: typeof starter === "object" });
    };
    expect(noStarter(list.runtimes[0])).toEqual(noStarter(want.runtimes[0]));
    expect(shapeOf(list.detection[0])).toEqual(shapeOf(want.detection[0]));
    expect((list as unknown as { planFiles: string[] }).planFiles).toEqual(
      (want as unknown as { planFiles: string[] }).planFiles,
    );
    const vite = {
      "package.json": JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }),
      "index.html": "",
    };
    const planned = await (
      await app.request("/runtimes/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paths: Object.keys(vite), files: vite }),
      })
    ).json();
    expect(planned).toEqual(contract["appPlan"]);
    const addons = (list as unknown as { addons: unknown[] }).addons;
    expect(shapeOf(addons[0])).toEqual(
      shapeOf((want as unknown as { addons: unknown[] }).addons[0]),
    );
    const { ADDON_IDS } = await import("@gangway/shared/addons");
    expect(contract["addonIds"]).toEqual([...ADDON_IDS]);

    const p = pack();
    p.entry({ name: "index.ts" }, "export default {}");
    p.finalize();
    const chunks: Buffer[] = [];
    for await (const c of p) chunks.push(c as Buffer);
    const res = await deploy(s.ctx, {
      actor: ACTOR,
      name: "rt",
      visibility: "public",
      source: { kind: "tarball", archive: gzipSync(Buffer.concat(chunks)), runtime: "bun" },
    });
    await res.done;
    expect(shapeOf(res.preview.source)).toEqual(shapeOf(contract["tarballSource"]));
    expect(shapeOf(await (await app.request(`/previews/${res.preview.id}/source`)).json())).toEqual(
      shapeOf(contract["previewSource"]),
    );

    s.fake.buildExit = 1;
    const accepted = await app.request(`/previews/${res.preview.id}/source?wait=true`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: { "index.ts": "x" } }),
    });
    const done = (await accepted.json()) as Record<string, unknown>;
    const { preview: _p, ...rest } = done;
    expect(shapeOf(rest)).toEqual(shapeOf(contract["redeployDone"]));
    const { events } = (await (await app.request(`/previews/${res.preview.id}/events`)).json()) as {
      events: { type: string; phase?: string }[];
    };
    expect(
      shapeOf(events.find((e) => e.type === "preview.redeploy" && e.phase === "started")),
    ).toEqual(shapeOf(contract["redeployEvent"]));
    for (const e of events) expect(contract["streamEventTypes"]).toContain(e.type);
  });
});
