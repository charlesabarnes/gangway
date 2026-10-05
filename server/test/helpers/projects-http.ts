// The projects routes with a fake engine and a stand-in for workflow runs' OIDC tokens.
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { createApp, surfaceHandler } from "../../src/app/app.ts";
import { authRoutes } from "../../src/app/routes/auth.ts";
import { previewRoutes } from "../../src/app/routes/previews.ts";
import { previewSecretRoutes } from "../../src/app/routes/secrets.ts";
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
import { SiteStore } from "../../src/previews/site.ts";
import { SourceStore } from "../../src/previews/source/store.ts";
import { Branches } from "../../src/projects/branches.ts";
import { Pulls } from "../../src/projects/pulls.ts";
import { redeploy } from "../../src/previews/redeploy.ts";
import { SecretBox } from "../../src/secrets/box.ts";
import { Secrets } from "../../src/secrets/secrets.ts";
import { MemorySettingsStore } from "../../src/settings.ts";
import { IdempotencyRepo } from "../../src/db/repos/idempotency.ts";
import { setupPreviewContext } from "./preview-context.ts";
import { silentLogger } from "./logger.ts";
import { HOME_ORG_ID } from "../../src/db/repos/orgs.ts";

export const ADMIN = "gw_projects_env_token_0123456789abcd";
export const HOST = "api.preview.localhost:8443";
export const IMAGE = "ghcr.io/acme/web-app/preview@sha256:" + "d".repeat(64);
export const SHA = "a".repeat(40);

// Stands in for a workflow run's OIDC token; verifyWorkflow below parses it.
export const wf = (repo = "acme/web-app", ref = "refs/pull/7/merge", event = "pull_request") =>
  `wf:${repo}:${event}:${ref}`;

export function make() {
  const s = setupPreviewContext();
  const stateDir = dirname(s.ctx.workdirs.root);
  s.ctx.sources = new SourceStore(stateDir);
  s.ctx.sites = new SiteStore(stateDir);
  const projects = new ProjectsRepo(s.db);
  const templates = new TemplatesRepo(s.db);
  s.ctx.policy = new PolicyResolver({
    templates,
    project: (ref) => projects.find(ref),
    defaultFor: () => "default",
    projectForSource: (src) => {
      if (src.kind === "pushed") {
        return projects.getByFullName("github", src.pr.repo);
      }
      if (src.kind === "tarball") {
        return src.pr && projects.getByFullName("github", src.pr.repo);
      }
      return src.kind === "pr" ? projects.getByFullName("github", src.repo) : undefined;
    },
  });
  const secrets = new Secrets(projects, new MemorySettingsStore(), new SecretBox(randomBytes(32)), {
    audit: s.ctx.audit,
    previews: s.ctx.previews,
  });
  s.ctx.secretsFor = (id, clearance) => secrets.valuesFor(id, clearance);
  s.ctx.secrets = secrets;
  const pulls = new Pulls({
    projects,
    previews: {
      deploy: (i) => deploy(s.ctx, i),
      destroy: (id, a) => destroy(s.ctx, id, a),
      findPullRequest: (r, n) => s.ctx.previews.findPullRequest(r, n),
      sealedSecrets: (id) => s.ctx.previews.envCiphertext(id),
    },
  });
  const branches = new Branches({
    projects,
    previews: {
      get: (id) => s.ctx.previews.get(id),
      list: (f) => s.ctx.previews.list(f),
      deploy: (i) => deploy(s.ctx, i),
      redeploy: (i) => redeploy(s.ctx, i),
      destroy: (id, a) => destroy(s.ctx, id, a),
      sealedSecrets: (id) => s.ctx.previews.envCiphertext(id),
    },
    audit: s.ctx.audit,
    refreshDomains: () => {
      refreshes++;
    },
  });
  let refreshes = 0;
  const verifyWorkflow = (presented: string): Actor | null => {
    const m = /^wf:([^:]+):([^:]+):(.+)$/.exec(presented);
    const run = { runId: "42", actor: "dev" };
    return m
      ? workflowActor({ ...run, repository: m[1]!, eventName: m[2]!, ref: m[3]! }, HOME_ORG_ID)
      : null;
  };
  const auth = {
    verifyToken: chainVerifiers(staticTokenVerifier(ADMIN, HOME_ORG_ID), verifyWorkflow),
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
        previews: s.ctx.previews,
        templates,
        pulls,
        branches,
        apiOrigin: () => "https://api.preview.localhost:8443",
        wire: (p) => ({ ...p, urls: urlsFor(s.ctx, p.id) }),
      });
      previewSecretRoutes(api, {
        secrets,
        previews: s.ctx.previews,
        projects,
        ctx: s.ctx,
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
  const call = (
    path: string,
    o: { method?: string; json?: unknown; tar?: Uint8Array; as?: string } = {},
  ) => {
    const headers = new Headers({ host: HOST, authorization: `Bearer ${o.as ?? ADMIN}` });
    if (o.json !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (o.tar !== undefined) {
      headers.set("content-type", "application/gzip");
    }
    const payload = o.tar ?? (o.json === undefined ? undefined : JSON.stringify(o.json));
    return Promise.resolve(
      handle(
        new Request(`https://${HOST}${path}`, {
          method: o.method ?? "GET",
          headers,
          ...(payload === undefined ? {} : { body: payload }),
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
  return { s, projects, secrets, call, body, refreshes: () => refreshes };
}
