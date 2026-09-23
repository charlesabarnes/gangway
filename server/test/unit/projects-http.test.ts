import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createApp, surfaceHandler } from "../../src/app/app.ts";
import { authRoutes } from "../../src/app/routes/auth.ts";
import { previewRoutes } from "../../src/app/routes/previews.ts";
import { projectRoutes } from "../../src/app/routes/projects.ts";
import {
  chainVerifiers,
  staticTokenVerifier,
  workflowActor,
  type Actor,
} from "../../src/auth/actor.ts";
import { Bootstrap } from "../../src/auth/bootstrap.ts";
import { ProjectsRepo, TemplatesRepo } from "../../src/db/repos/index.ts";
import { deploy, urlsFor } from "../../src/previews/deploy.ts";
import { destroy } from "../../src/previews/destroy.ts";
import { IdempotentDeploys } from "../../src/previews/idempotent.ts";
import { PolicyResolver } from "../../src/previews/policy.ts";
import { Pulls, registryOf } from "../../src/projects/pulls.ts";
import { workflowFor } from "../../src/projects/workflow.ts";
import { SecretBox } from "../../src/secrets/box.ts";
import { Secrets } from "../../src/secrets/secrets.ts";
import { MemorySettingsStore } from "../../src/settings.ts";
import { IdempotencyRepo } from "../../src/db/repos/idempotency.ts";
import { setupPreviewContext } from "../helpers/preview-context.ts";
import { silentLogger } from "../helpers/logger.ts";

const ADMIN = "gw_projects_env_token_0123456789abcd";
const HOST = "api.preview.localhost:8443";
const IMAGE = "ghcr.io/acme/web-app/preview@sha256:" + "d".repeat(64);
const SHA = "a".repeat(40);

// Stands in for a workflow run's OIDC token; verifyWorkflow below parses it.
const wf = (repo = "acme/web-app", ref = "refs/pull/7/merge", event = "pull_request") =>
  `wf:${repo}:${event}:${ref}`;

function make() {
  const s = setupPreviewContext();
  const projects = new ProjectsRepo(s.db);
  const templates = new TemplatesRepo(s.db);
  s.ctx.policy = new PolicyResolver({
    templates,
    project: (ref) => projects.find(ref),
    defaultFor: () => "default",
    projectForSource: (src) =>
      src.kind === "pushed"
        ? projects.getByFullName("github", src.pr.repo)
        : src.kind === "pr"
          ? projects.getByFullName("github", src.repo)
          : undefined,
  });
  const secrets = new Secrets(
    projects,
    new MemorySettingsStore(),
    new SecretBox(randomBytes(32)),
    s.ctx.audit,
  );
  s.ctx.secretsFor = (id, clearance) => secrets.valuesFor(id, clearance);
  const pulls = new Pulls({
    projects,
    previews: {
      deploy: (i) => deploy(s.ctx, i),
      destroy: (id, a) => destroy(s.ctx, id, a),
      findPullRequest: (r, n) => s.ctx.previews.findPullRequest(r, n),
    },
  });
  const verifyWorkflow = (presented: string): Actor | null => {
    const m = /^wf:([^:]+):([^:]+):(.+)$/.exec(presented);
    return m
      ? workflowActor({
          repository: m[1]!,
          eventName: m[2]!,
          ref: m[3]!,
          runId: "42",
          actor: "dev",
        })
      : null;
  };
  const auth = {
    verifyToken: chainVerifiers(staticTokenVerifier(ADMIN), verifyWorkflow),
    originFor: (h: string) => `https://${h}`,
  };
  const hono = createApp({
    ...auth,
    logger: silentLogger(),
    v1: (api) => {
      previewRoutes(api, s.ctx, new IdempotentDeploys(s.ctx, new IdempotencyRepo(s.db)));
      projectRoutes(api, {
        projects,
        audit: s.ctx.audit,
        secrets,
        templates,
        pulls,
        apiOrigin: () => "https://api.preview.localhost:8443",
        wire: (p) => ({ ...p, urls: urlsFor(s.ctx, p.id) }),
      });
    },
    publicV1: (pub) =>
      authRoutes(pub, {
        auth,
        accounts: null as never,
        bootstrap: new Bootstrap(() => 1),
        roles: null as never,
        sessionMaxAgeSec: 60,
      }),
  });
  const handle = surfaceHandler(hono, "api");
  const call = (path: string, o: { method?: string; json?: unknown; as?: string } = {}) => {
    const headers = new Headers({ host: HOST, authorization: `Bearer ${o.as ?? ADMIN}` });
    if (o.json !== undefined) headers.set("content-type", "application/json");
    return Promise.resolve(
      handle(
        new Request(`https://${HOST}${path}`, {
          method: o.method ?? "GET",
          headers,
          ...(o.json === undefined ? {} : { body: JSON.stringify(o.json) }),
        }),
        { clientIp: "203.0.113.7" },
      ),
    );
  };
  const body = (over: Record<string, unknown> = {}) => ({
    image: IMAGE,
    port: 3000,
    sha: SHA,
    registry: { username: "dev", password: "ghs_registry_token_value" },
    ...over,
  });
  return { s, projects, secrets, call, body };
}

describe("/v1/projects", () => {
  test("creates a project with a slug from its name and the workflow trigger", async () => {
    const t = make();
    let res = await t.call("/v1/projects", {
      method: "POST",
      json: { name: "Web App", repository: "acme/web-app" },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).project).toMatchObject({
      name: "Web App",
      slug: "web-app",
      forge: "github",
      fullName: "acme/web-app",
      prTrigger: "workflow",
      enabled: true,
    });
    res = await t.call("/v1/projects", { method: "POST", json: { name: "whoami" } });
    expect(((await res.json()) as any).project).toMatchObject({
      slug: "whoami",
      forge: null,
      fullName: null,
    });
    expect(
      ((await (await t.call("/v1/projects")).json()) as any).projects.map((p: any) => p.slug),
    ).toEqual(["web-app", "whoami"]);
    expect(t.s.audit.page({ limit: 1 }).entries[0]).toMatchObject({ action: "project.created" });
  });

  test.each([
    ["a taken slug", { name: "web app" }, 409],
    ["a taken repository in another case", { name: "again", repository: "Acme/Web-App" }, 409],
    ["a malformed repository", { name: "x", repository: "not a repo" }, 422],
    ["an unknown template", { name: "x", templateId: "ghost" }, 422],
  ])("refuses to create a project with %s", async (_, json, status) => {
    const t = make();
    t.projects.create({
      id: "P1",
      name: "Web App",
      slug: "web-app",
      forge: "github",
      fullName: "acme/web-app",
    });
    expect((await t.call("/v1/projects", { method: "POST", json })).status).toBe(status);
  });

  test("edits by id or slug, changes or removes the repository, and deletes", async () => {
    const t = make();
    const p = t.projects.create({
      id: "P1",
      name: "web",
      slug: "web",
      forge: "github",
      fullName: "acme/web-app",
    });
    const res = await t.call("/v1/projects/web", {
      method: "PATCH",
      json: {
        name: "Web",
        prTrigger: "webhook",
        visibility: "private",
        templateId: null,
        repository: "acme/web",
      },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).project).toMatchObject({
      name: "Web",
      prTrigger: "webhook",
      visibility: "private",
      fullName: "acme/web",
    });
    expect(
      (await t.call(`/v1/projects/${p.id}`, { method: "PATCH", json: { repository: null } }))
        .status,
    ).toBe(200);
    expect(t.projects.get(p.id)).toMatchObject({ forge: null, fullName: null });
    expect(
      (await t.call("/v1/projects/web", { method: "PATCH", json: { ttl: "soon" } })).status,
    ).toBe(422);
    expect(
      (await t.call("/v1/projects/nope", { method: "PATCH", json: { name: "x" } })).status,
    ).toBe(404);
    expect((await t.call("/v1/projects/web", { method: "DELETE" })).status).toBe(204);
    expect((await t.call("/v1/projects/web")).status).toBe(404);
  });

  test("the workflow file names the project and API and keeps GitHub's `${{ }}`", async () => {
    const t = make();
    t.projects.create({
      id: "P1",
      name: "Web app",
      slug: "web-app",
      forge: "github",
      fullName: "acme/web-app",
    });
    const res = await t.call("/v1/projects/web-app/workflow?port=8080");
    expect(res.headers.get("content-type")).toContain("text/yaml");
    expect(res.headers.get("x-gangway-path")).toBe(".github/workflows/gangway-preview.yml");
    const yaml = await res.text();
    expect(yaml).toContain("GANGWAY_API: https://api.preview.localhost:8443");
    expect(yaml).toContain("GANGWAY_PROJECT: web-app");
    expect(yaml).toContain('PORT: "8080"');
    expect(yaml).toContain("${{ github.event.pull_request.number }}");
    expect(yaml).toContain("id-token: write");
    expect(yaml).not.toMatch(/__[A-Z]+__/);
    expect(workflowFor({ name: "x", slug: "x" }, "https://a")).toContain('PORT: "3000"');
  });
});

describe("/v1/projects/:ref/pulls/:n", () => {
  const setup = () => {
    const t = make();
    t.projects.create({
      id: "P1",
      name: "web-app",
      slug: "web-app",
      forge: "github",
      fullName: "acme/web-app",
    });
    return t;
  };

  test("deploys the pushed image as the PR's preview, logging in for `up` only", async () => {
    const t = setup();
    t.secrets.project("P1").update(null, { set: { API_KEY: "k-123" } });
    const res = await t.call("/v1/projects/web-app/pulls/7?wait=true", {
      method: "PUT",
      as: wf(),
      json: t.body(),
    });
    expect(res.status).toBe(201);
    const { preview } = (await res.json()) as any;
    expect(preview).toMatchObject({
      state: "awake",
      projectId: "P1",
      templateId: "default",
      source: { kind: "pr", repo: "acme/web-app", number: 7, sha: SHA, image: IMAGE },
    });
    expect(preview.urls[0].url).toMatch(
      /^https:\/\/web-app-pr-7-[a-z0-9]+\.preview\.localhost:8443\/$/,
    );
    const login = t.s.fake.upLogins[0]!;
    expect(JSON.parse(login.config!)).toEqual({
      auths: {
        "ghcr.io": { auth: Buffer.from("dev:ghs_registry_token_value").toString("base64") },
      },
    });
    expect(await Bun.file(`${login.env!["DOCKER_CONFIG"]}/config.json`).exists()).toBe(false);
    const everywhere = JSON.stringify([
      t.s.previews.get(preview.id),
      t.s.ctx.logs.tail(preview.id),
      t.s.audit.page({ limit: 20 }).entries,
    ]);
    expect(everywhere).not.toContain("ghs_registry_token_value");
    expect(everywhere).not.toContain("k-123");
  });

  test("a new head replaces the preview, the same head does not, and close is idempotent", async () => {
    const t = setup();
    const first = (await (
      await t.call("/v1/projects/web-app/pulls/7?wait=true", {
        method: "PUT",
        as: wf(),
        json: t.body(),
      })
    ).json()) as any;
    const again = await t.call("/v1/projects/web-app/pulls/7?wait=true", {
      method: "PUT",
      as: wf(),
      json: t.body(),
    });
    expect(again.status).toBe(200);
    expect((await again.json()) as any).toMatchObject({
      unchanged: true,
      preview: { id: first.preview.id },
    });
    const next = (await (
      await t.call("/v1/projects/web-app/pulls/7?wait=true", {
        method: "PUT",
        as: wf(),
        json: t.body({ sha: "b".repeat(40), image: IMAGE.replace(/d+$/, "e".repeat(64)) }),
      })
    ).json()) as any;
    expect(next.preview.id).not.toBe(first.preview.id);
    expect(t.s.previews.get(first.preview.id)!.state).toBe("destroyed");
    expect(t.s.fake.downArgvs[0]).toContain("all");

    expect(
      (await t.call("/v1/projects/web-app/pulls/7", { method: "DELETE", as: wf() })).status,
    ).toBe(204);
    expect(t.s.previews.get(next.preview.id)!.state).toBe("destroyed");
    expect(
      (await t.call("/v1/projects/web-app/pulls/7", { method: "DELETE", as: wf() })).status,
    ).toBe(204);
  });

  test.each([
    ["another repository", wf("evil/web-app")],
    ["another pull request", wf("acme/web-app", "refs/pull/8/merge")],
    ["a push", wf("acme/web-app", "refs/heads/main", "push")],
    ["a pull_request_target event", wf("acme/web-app", "refs/pull/7/merge", "pull_request_target")],
  ])("refuses a workflow run from %s", async (_, as) => {
    const t = setup();
    const res = await t.call("/v1/projects/web-app/pulls/7", { method: "PUT", as, json: t.body() });
    expect(res.status).toBe(403);
    expect(t.s.previews.list()).toEqual([]);
  });

  test("a workflow is refused by a webhook-mode or disabled project", async () => {
    const t = setup();
    const put = (as: string) =>
      t.call("/v1/projects/web-app/pulls/7", { method: "PUT", as, json: t.body() });
    t.projects.update("P1", { prTrigger: "webhook" });
    expect((await put(wf())).status).toBe(409);
    t.projects.update("P1", { prTrigger: "workflow", enabled: false });
    expect((await put(wf())).status).toBe(409);
    expect(t.s.previews.list()).toEqual([]);
  });

  test("a workflow token reaches nothing but its pull request", async () => {
    const t = setup();
    expect((await t.call("/v1/previews", { as: wf() })).status).toBe(403);
    expect(
      (
        await t.call("/v1/previews", {
          method: "POST",
          as: wf(),
          json: { source: { kind: "image", image: "nginx", port: 80 } },
        })
      ).status,
    ).toBe(403);
    expect((await t.call("/v1/projects/web-app", { as: wf() })).status).toBe(403);
    expect((await t.call("/v1/projects/web-app/env", { as: wf() })).status).toBe(403);
    expect(
      (await t.call("/v1/projects/web-app/pulls/7/extra", { method: "PUT", as: wf() })).status,
    ).toBe(403);
  });

  test("an admin may deploy a pull request by hand; a project with no repository cannot", async () => {
    const t = setup();
    const res = await t.call("/v1/projects/web-app/pulls/3", {
      method: "PUT",
      json: t.body({ registry: undefined }),
    });
    expect(res.status).toBe(202);
    const { preview } = (await res.json()) as any;
    await t.s.ctx.inflight.get(preview.id)?.done;
    expect(t.s.fake.upLogins[0]).toEqual({ env: undefined, config: null });
    t.projects.create({ id: "P2", name: "bare", slug: "bare" });
    expect(
      (await t.call("/v1/projects/bare/pulls/3", { method: "PUT", json: t.body() })).status,
    ).toBe(422);
    expect(
      (await t.call("/v1/projects/web-app/pulls/0", { method: "PUT", json: t.body() })).status,
    ).toBe(400);
    expect(
      (
        await t.call("/v1/projects/web-app/pulls/3", {
          method: "PUT",
          json: t.body({ image: "not an image!" }),
        })
      ).status,
    ).toBe(422);
  });

  test("a plain deploy that names a project is filed under it and follows its policy", async () => {
    const t = setup();
    t.projects.update("P1", { visibility: "public" });
    const res = await t.call("/v1/previews?wait=true", {
      method: "POST",
      json: {
        name: "adhoc",
        project: "web-app",
        source: { kind: "image", image: "traefik/whoami:v1.10", port: 80 },
      },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).preview).toMatchObject({
      projectId: "P1",
      visibility: "public",
    });
    expect(
      (
        await t.call("/v1/previews", {
          method: "POST",
          json: { project: "ghost", source: { kind: "image", image: "x", port: 80 } },
        })
      ).status,
    ).toBe(422);
  });

  test.each([
    ["ghcr.io/acme/web", "ghcr.io"],
    ["registry.example.com:5000/x@sha256:ab", "registry.example.com:5000"],
    ["acme/web", "docker.io"],
    ["nginx", "docker.io"],
  ])("registryOf(%s) is %s", (image, registry) => {
    expect(registryOf(image)).toBe(registry);
  });
});
