/**
 * /v1/projects through the real app (ADR-0014): made on purpose, tuned, given secrets; and
 * `/pulls/:n`, where a workflow run -- identified by its OIDC token -- deploys and tears
 * down its pull requests' previews, and can do nothing else.
 */
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
import { Logger } from "../../src/logger.ts";
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

const ADMIN = "gw_projects_env_token_0123456789abcd";
const HOST = "api.preview.localhost:8443";
const IMAGE = "ghcr.io/acme/web-app/preview@sha256:" + "d".repeat(64);
const SHA = "a".repeat(40);

/** A workflow run's token, as the OIDC verifier would resolve it: `wf:<repo>:<event>:<ref>`. */
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
    logger: new Logger("error", {}, () => {}),
    v1: (api) => {
      previewRoutes(api, s.ctx, new IdempotentDeploys(s.ctx, new IdempotencyRepo(s.db)));
      projectRoutes(api, {
        projects,
        audit: s.ctx.audit!,
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
  test("made on purpose: slug from the name, workflow by default; a taken slug or repository is 409; with no repository it is fine", async () => {
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
    expect(
      (await t.call("/v1/projects", { method: "POST", json: { name: "web app" } })).status,
    ).toBe(409);
    res = await t.call("/v1/projects", {
      method: "POST",
      json: { name: "again", repository: "Acme/Web-App" },
    });
    expect(res.status).toBe(409);
    expect(
      (
        await t.call("/v1/projects", {
          method: "POST",
          json: { name: "x", repository: "not a repo" },
        })
      ).status,
    ).toBe(422);
    expect(
      (await t.call("/v1/projects", { method: "POST", json: { name: "x", templateId: "ghost" } }))
        .status,
    ).toBe(422);
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

  test("tuned by id or slug; the repository can be changed or removed; delete leaves previews running, unowned", async () => {
    const t = make();
    const p = t.projects.create({
      id: "P1",
      name: "web",
      slug: "web",
      forge: "github",
      fullName: "acme/web-app",
    });
    let res = await t.call("/v1/projects/web", {
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

  test("the workflow file names this project and our API, and keeps GitHub's `${{ }}` intact", async () => {
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

describe("/v1/projects/:ref/pulls/:n -- from the project's own workflow", () => {
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

  test("deploys the pushed image as the PR's preview, filed under the project, with its secrets as env; the registry login lives for `up` only", async () => {
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
    // Gone once `up` returned; and never on the row, in the log or the audit.
    expect(await Bun.file(`${login.env!["DOCKER_CONFIG"]}/config.json`).exists()).toBe(false);
    const everywhere = JSON.stringify([
      t.s.previews.get(preview.id),
      t.s.ctx.logs.tail(preview.id),
      t.s.audit.page({ limit: 20 }).entries,
    ]);
    expect(everywhere).not.toContain("ghs_registry_token_value");
    expect(everywhere).not.toContain("k-123");
  });

  test("the same head again is left alone; a new head replaces the preview; close tears it down with its image, and closing again is fine", async () => {
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
    expect(t.s.fake.downArgvs[0]).toContain("all"); // --rmi all: the per-commit image goes with it

    expect(
      (await t.call("/v1/projects/web-app/pulls/7", { method: "DELETE", as: wf() })).status,
    ).toBe(204);
    expect(t.s.previews.get(next.preview.id)!.state).toBe("destroyed");
    expect(
      (await t.call("/v1/projects/web-app/pulls/7", { method: "DELETE", as: wf() })).status,
    ).toBe(204);
  });

  test("a workflow acts only for its own repository, its own PR, on a pull_request event, for a workflow-mode project", async () => {
    const t = setup();
    const put = (as: string, path = "/v1/projects/web-app/pulls/7") =>
      t.call(path, { method: "PUT", as, json: t.body() });
    expect((await put(wf("evil/web-app"))).status).toBe(403);
    expect((await put(wf("acme/web-app", "refs/pull/8/merge"))).status).toBe(403);
    expect((await put(wf("acme/web-app", "refs/heads/main", "push"))).status).toBe(403);
    expect((await put(wf("acme/web-app", "refs/pull/7/merge", "pull_request_target"))).status).toBe(
      403,
    );
    t.projects.update("P1", { prTrigger: "webhook" });
    expect((await put(wf())).status).toBe(409);
    t.projects.update("P1", { prTrigger: "workflow", enabled: false });
    expect((await put(wf())).status).toBe(409);
    expect(t.s.previews.list()).toEqual([]);
  });

  test("a workflow token reaches nothing else: not the preview list, not a plain deploy, not the project's settings", async () => {
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

  test("an admin may do the same by hand; a project with no repository has no pull requests", async () => {
    const t = setup();
    const res = await t.call("/v1/projects/web-app/pulls/3", {
      method: "PUT",
      json: t.body({ registry: undefined }),
    });
    expect(res.status).toBe(202); // without ?wait, answered as soon as the preview exists
    const { preview } = (await res.json()) as any;
    await t.s.ctx.inflight.get(preview.id)?.done;
    expect(t.s.fake.upLogins[0]).toEqual({ env: undefined, config: null }); // no login given, none written
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

  test("a plain deploy can name a project: it is filed under it and follows its policy", async () => {
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

  test("registryOf: the host an image reference names", () => {
    expect(registryOf("ghcr.io/acme/web")).toBe("ghcr.io");
    expect(registryOf("registry.example.com:5000/x@sha256:ab")).toBe("registry.example.com:5000");
    expect(registryOf("acme/web")).toBe("docker.io");
    expect(registryOf("nginx")).toBe("docker.io");
  });
});
