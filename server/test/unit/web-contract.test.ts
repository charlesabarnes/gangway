/**
 * The UI's types are hand-written (web/src/app/core/api.types.ts): what crosses the network
 * is JSON, and the server's domain types are not. This is the server's half of keeping them
 * honest. It asserts that REAL output has exactly the shape and literals recorded in
 * web/src/testing/fixtures/contract.json; the web project's spec asserts that file
 * satisfies its types. Rename a field or add a state on either side alone: a test fails.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { DISABLE_UI_PHRASE, PREVIEW_STATE_VALUES, VISIBILITY_VALUES } from "../../../shared/src/api.ts";
import { CLEARANCES, TRIGGERS } from "../../../shared/src/domain.ts";
import { ALL_PERMISSIONS, SCOPES, SCOPE_PERMISSIONS } from "../../../shared/src/permissions.ts";
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
import { staticTokenVerifier, tokenActor } from "../../src/auth/actor.ts";
import { Bootstrap } from "../../src/auth/bootstrap.ts";
import { Tokens } from "../../src/auth/tokens.ts";
import { ProjectsRepo } from "../../src/db/repos/projects.ts";
import { TemplatesRepo } from "../../src/db/repos/templates.ts";
import { ManifestStates } from "../../src/forge/github/manifest.ts";
import { Logger } from "../../src/logger.ts";
import { MemorySettingsStore, SETTINGS, Settings } from "../../src/settings.ts";
import { LOG_STREAMS } from "../../src/previews/logs.ts";
import { PASSWORD, setupAccounts } from "../helpers/accounts.ts";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";

const contract = JSON.parse(readFileSync(join(import.meta.dir, "../../../web/src/testing/fixtures/contract.json"), "utf8")) as Record<string, unknown>;
const quiet = new Logger("error", {}, () => {});

/** Keys and value TYPES, recursively; an array is the shape of its first element. Values do not matter. */
function shapeOf(v: unknown): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length === 0 ? [] : [shapeOf(v[0])];
  if (typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, shapeOf(x)]));
  return typeof v;
}

describe("string unions the UI switches on", () => {
  test("preview states, visibilities, log streams, scopes", () => {
    expect(contract["previewStates"]).toEqual([...PREVIEW_STATE_VALUES]);
    expect(contract["visibilities"]).toEqual([...VISIBILITY_VALUES]);
    expect(contract["logStreams"]).toEqual([...LOG_STREAMS]);
    expect(contract["scopes"]).toEqual([...SCOPES]);
  });

  test("what each token scope grants: the UI greys out a scope the role does not cover, from this", () => {
    const sorted = (o: Record<string, readonly string[]>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [...v].sort()]));
    expect(sorted(contract["scopePermissions"] as Record<string, string[]>)).toEqual(sorted(SCOPE_PERMISSIONS));
  });

  test("the permission ids the UI gates on are exactly the catalogue", () => {
    expect([...(contract["permissions"] as string[])].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });
});

describe("preview wire shapes", () => {
  const api = (s: ReturnType<typeof setupPreviewContext>) => {
    const app = new Hono<AppEnv>();
    app.onError(errorHandler(quiet));
    app.use(async (c, next) => { c.set("requestId", "r"); c.set("actor", ACTOR); return next(); });
    previewRoutes(app, s.ctx, null as never);
    return app;
  };

  test("a preview, the list envelope, and a history event", async () => {
    const s = setupPreviewContext();
    const p = await s.deployed("contract");
    const app = api(s);
    const detail = await (await app.request(`/previews/${p.id}`)).json() as { preview: unknown };
    expect(shapeOf(detail.preview)).toEqual(shapeOf(contract["preview"]));

    const list = await (await app.request("/previews")).json() as { seq: number; previews: unknown[] };
    expect(Object.keys(list).sort()).toEqual(Object.keys(contract["previewList"] as object).sort());
    expect(shapeOf(list.previews[0])).toEqual(shapeOf(contract["preview"]));

    const { events } = await (await app.request(`/previews/${p.id}/events`)).json() as { events: { type: string }[] };
    expect(shapeOf(events.find((e) => e.type === "preview.state"))).toEqual(shapeOf(contract["previewEvent"]));
  });

  test("every event type the server publishes to the stream is one the UI listens for", async () => {
    const s = setupPreviewContext();
    await s.deployed("types");
    const published = new Set(s.ctx.bus.history((s.previews.list()[0]!).id).map((e) => e.type));
    for (const type of published) expect(contract["streamEventTypes"]).toContain(type);
    expect(contract["streamEventTypes"]).toContain("reset"); // synthetic, from EventBus.follow
  });
});

describe("account wire shapes", () => {
  test("session (anonymous and logged in), login, a token, and a problem", async () => {
    const s = setupAccounts();
    const tokens = new Tokens(s.tokensRepo, s.roles, s.audit, s.now);
    const auth = { verifyToken: staticTokenVerifier("gw_contract_env_token_0123456789abcd"), resolveSession: (x: string) => s.sessions.resolve(x)?.actor ?? null, originFor: (h: string) => `https://${h}` };
    const app = createApp({
      ...auth, logger: quiet, v1: (a) => tokenRoutes(a, tokens),
      publicV1: (pub) => authRoutes(pub, { auth, accounts: s.accounts, bootstrap: new Bootstrap(() => s.users.count()), roles: s.roles, sessionMaxAgeSec: 60 }),
    });
    const h = surfaceHandler(app, "app");
    const HOST = "app.preview.localhost";
    const call = (path: string, init: RequestInit = {}) => Promise.resolve(h(new Request(`https://${HOST}${path}`, { ...init, headers: { host: HOST, origin: `https://${HOST}`, "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) } }), { clientIp: "::1" }));

    expect(shapeOf(await (await call("/v1/auth/session")).json())).toEqual(shapeOf(contract["sessionAnonymous"]));

    await s.admin();
    const login = await call("/v1/auth/login", { method: "POST", body: JSON.stringify({ email: "ada@example.com", password: PASSWORD }) });
    expect(shapeOf(await login.json())).toEqual(shapeOf(contract["login"]));
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect(shapeOf(await (await call("/v1/auth/session", { headers: { cookie } })).json())).toEqual(shapeOf(contract["sessionUser"]));

    const minted = await (await call("/v1/tokens", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "ci", scopes: ["deploy"] }) })).json() as { token: unknown };
    expect(shapeOf(minted.token)).toEqual(shapeOf(contract["token"]));

    // A read-only token refused a write: the 403 the UI shows in a toast.
    void tokenActor;
    const denied = await call("/v1/tokens", { headers: { authorization: "Bearer gw_nope" } });
    expect(Object.keys(await denied.json() as object).sort()).toEqual(Object.keys(contract["problem"] as object).sort());
  });
});

describe("surface wire shapes (§10.5)", () => {
  test("GET /v1/surfaces, GET /v1/capabilities, and the phrase", async () => {
    const settings = new Settings({}, new MemorySettingsStore());
    const api = new Hono<AppEnv>();
    api.onError(errorHandler(quiet));
    api.use(async (c, next) => { c.set("actor", ACTOR); await next(); });
    surfaceRoutes(api, { settings, audit: { record() {} }, hasActiveAdmin: () => false, apiOrigin: () => "https://api.preview.localhost:8443", mcpOrigin: () => "https://mcp.preview.localhost:8443" });
    const { surfaces } = (await (await api.request("/surfaces")).json()) as { surfaces: unknown };
    expect(shapeOf(surfaces)).toEqual(shapeOf(contract["surfaces"]));
    expect(surfaces).toEqual(contract["surfaces"]);
    expect(shapeOf(await (await api.request("/capabilities")).json())).toEqual(shapeOf(contract["capabilities"]));
    expect(contract["disableUiPhrase"]).toBe(DISABLE_UI_PHRASE);
  });
});

describe("github wire shapes (ADR-0011)", () => {
  test("the status and a repository", async () => {
    const s = setupAccounts();
    const settings = new Settings({}, new MemorySettingsStore());
    settings.set(SETTINGS.githubAppId, "777"); settings.set(SETTINGS.githubAppSlug, "gangway-preview");
    settings.set(SETTINGS.githubPrivateKey, "k"); settings.set(SETTINGS.githubWebhookSecret, "s");
    const repos = new ProjectsRepo(s.db, s.now);
    repos.create({ id: "r1", name: "web", forge: "github", fullName: "acme/web-app", installationId: "4242", slug: "web-app" });
    const app = new Hono<AppEnv>();
    app.onError(errorHandler(quiet));
    app.use(async (c, next) => { c.set("requestId", "r"); c.set("actor", ACTOR); return next(); });
    const templates = new TemplatesRepo(s.db, s.now);
    projectRoutes(app, { projects: repos, audit: s.audit, templates });
    templateRoutes(app, { templates, hosts: { get: () => undefined }, audit: s.audit, namedByTrigger: () => [] });
    githubRoutes(app, { app: null as never, settings, states: new ManifestStates(), audit: s.audit, baseDomain: () => "preview.localhost", originFor: (l) => `https://${l}.preview.localhost:8443` });

    expect(shapeOf(await (await app.request("/github")).json())).toEqual(shapeOf(contract["githubStatus"]));
    const { project } = await (await app.request("/projects/r1")).json() as { project: unknown };
    expect(shapeOf(project)).toEqual(shapeOf(contract["project"]));
    // A project with no repository: forge and fullName are null, not absent.
    repos.create({ id: "r2", name: "whoami", slug: "whoami" });
    const bare = (await (await app.request("/projects/whoami")).json() as { project: Record<string, unknown> }).project;
    expect(Object.keys(bare).sort()).toEqual(Object.keys(contract["project"] as object).sort());
    expect(bare).toMatchObject({ forge: null, fullName: null });
    expect(contract["forkPolicies"]).toEqual(["ask", "auto", "never"]);
    expect(contract["clearances"]).toEqual([...CLEARANCES]);
    // ADR-0013: a template, and the triggers a default is set for.
    const { template } = await (await app.request("/templates/default")).json() as { template: unknown };
    expect(shapeOf(template)).toEqual(shapeOf(contract["template"]));
    expect(contract["triggers"]).toEqual([...TRIGGERS]);
  });
});

describe("runtime wire shapes (ADR-0015)", () => {
  test("the catalogue, a kept source, a redeploy event, an upload's source, and the runtime ids", async () => {
    const { SourceStore } = await import("../../src/previews/source/store.ts");
    const { runtimeRoutes } = await import("../../src/app/routes/runtimes.ts");
    const { deploy } = await import("../../src/previews/deploy.ts");
    const { redeploy } = await import("../../src/previews/redeploy.ts");
    const { RUNTIME_IDS } = await import("../../../shared/src/runtimes.ts");
    const { pack } = await import("tar-stream");
    const { gzipSync } = await import("node:zlib");
    const { dirname } = await import("node:path");
    const s = setupPreviewContext();
    s.ctx.sources = new SourceStore(dirname(s.ctx.workdirs.root));
    const app = new Hono<AppEnv>();
    app.onError(errorHandler(quiet));
    app.use(async (c, next) => { c.set("requestId", "r"); c.set("actor", ACTOR); return next(); });
    previewRoutes(app, s.ctx, null as never);
    runtimeRoutes(app);

    expect(contract["runtimeIds"]).toEqual([...RUNTIME_IDS]);
    const list = await (await app.request("/runtimes")).json() as { runtimes: unknown[]; detection: unknown[] };
    const want = contract["runtimeList"] as { runtimes: unknown[]; detection: unknown[] };
    expect(Object.keys(list).sort()).toEqual(Object.keys(want).sort());
    // Starter maps differ per runtime; their VALUES are strings -- compare the rest of the shape.
    const noStarter = (r: unknown) => { const { starter, ...rest } = r as Record<string, unknown>; return shapeOf({ ...rest, starterIsObject: typeof starter === "object" }); };
    expect(noStarter(list.runtimes[0])).toEqual(noStarter(want.runtimes[0]));
    expect(shapeOf(list.detection[0])).toEqual(shapeOf(want.detection[0]));
    // ADR-0016: the files a plan reads, and the plan itself, for a Vite app.
    expect((list as unknown as { planFiles: string[] }).planFiles).toEqual((want as unknown as { planFiles: string[] }).planFiles);
    const vite = { "package.json": JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }), "index.html": "" };
    const planned = await (await app.request("/runtimes/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths: Object.keys(vite), files: vite }) })).json();
    expect(planned).toEqual(contract["appPlan"]);
    // ADR-0017: the add-on catalogue the New screen offers.
    const addons = (list as unknown as { addons: unknown[] }).addons;
    expect(shapeOf(addons[0])).toEqual(shapeOf((want as unknown as { addons: unknown[] }).addons[0]));
    const { ADDON_IDS } = await import("../../../shared/src/addons.ts");
    expect(contract["addonIds"]).toEqual([...ADDON_IDS]);

    const p = pack(); p.entry({ name: "index.ts" }, "export default {}"); p.finalize();
    const chunks: Buffer[] = []; for await (const c of p) chunks.push(c as Buffer);
    const res = await deploy(s.ctx, { actor: ACTOR, name: "rt", visibility: "public", source: { kind: "tarball", archive: gzipSync(Buffer.concat(chunks)), runtime: "bun" } });
    await res.done;
    expect(shapeOf(res.preview.source)).toEqual(shapeOf(contract["tarballSource"]));
    expect(shapeOf(await (await app.request(`/previews/${res.preview.id}/source`)).json())).toEqual(shapeOf(contract["previewSource"]));

    s.fake.buildExit = 1;
    const accepted = await app.request(`/previews/${res.preview.id}/source?wait=true`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ files: { "index.ts": "x" } }) });
    const done = await accepted.json() as Record<string, unknown>;
    const { preview: _p, ...rest } = done;
    expect(shapeOf(rest)).toEqual(shapeOf(contract["redeployDone"]));
    void redeploy;
    const { events } = await (await app.request(`/previews/${res.preview.id}/events`)).json() as { events: { type: string; phase?: string }[] };
    expect(shapeOf(events.find((e) => e.type === "preview.redeploy" && e.phase === "started"))).toEqual(shapeOf(contract["redeployEvent"]));
    for (const e of events) expect(contract["streamEventTypes"]).toContain(e.type);
  });
});
