import type { Context, Hono } from "hono";
import {
  EnvPatchSchema,
  ProjectCreateSchema,
  ProjectPatchSchema,
  PullDeploySchema,
  PullUploadQuerySchema,
  type ProjectPatchRequest,
} from "@gangway/shared/api";
import type { Preview, Project } from "@gangway/shared/domain";
import type { AuditSink } from "../../audit/audit.ts";
import type { ProjectsRepo } from "../../db/repos/projects.ts";
import type { TemplatesRepo } from "../../db/repos/templates.ts";
import { can, type Actor } from "../../auth/actor.ts";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../../errors.ts";
import {
  auditFields,
  checkRepository,
  checkTemplate,
  createProject,
} from "../../projects/create.ts";
import { readJson } from "../problem.ts";
import { isTarballRequest } from "./previews.ts";
import type { PreviewUrl } from "../../previews/deploy-types.ts";
import type { Branches } from "../../projects/branches.ts";
import { applyDeployHost, type DeployHostDeps } from "../../projects/deploy-host.ts";
import type { PullDeployRequest, Pulls } from "../../projects/pulls.ts";
import {
  pushWorkflowFor,
  WORKFLOW_PATH_IN_REPO,
  PUSH_WORKFLOW_PATH_IN_REPO,
  workflowFor,
} from "../../projects/workflow.ts";
import { changeSecrets, listSecrets, type SecretChangeDeps } from "../../secrets/change.ts";
import type { Secrets } from "../../secrets/secrets.ts";
import { parseDuration } from "../../util/duration.ts";
import type { DomainRegistry } from "../../domains/registry.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";
import { acrossOrgs } from "../../tenancy/scope.ts";

export type ProjectRouteDeps = {
  projects: ProjectsRepo;
  audit: AuditSink;
  secrets?: Secrets | undefined;
  previews?: SecretChangeDeps["previews"] | undefined;
  templates?: Pick<TemplatesRepo, "get"> | undefined;
  pulls?: Pulls | undefined;
  branches?: Branches | undefined;
  deployHost?: DeployHostDeps | undefined;
  wire?: ((p: Preview) => Preview & { urls: PreviewUrl[] }) | undefined;
  apiOrigin?: (() => string) | undefined;
  domains?: DomainRegistry | undefined;
};

export function projectRoutes(api: Hono<AppEnv>, d: ProjectRouteDeps): void {
  const { projects, audit } = d;

  api.get("/projects", requirePermission("previews.read"), (c) =>
    c.json({ projects: projects.list() }),
  );

  api.get("/projects/:ref", requirePermission("previews.read"), (c) =>
    c.json({ project: findProject(projects, c.req.param("ref")) }),
  );

  api.post("/projects", requirePermission("repos.manage"), async (c) => {
    const req = ProjectCreateSchema.parse(await readJson(c));
    return c.json({ project: createProject(d, c.get("actor"), req) }, 201);
  });

  api.patch("/projects/:ref", requirePermission("repos.manage"), async (c) => {
    const before = findProject(projects, c.req.param("ref"));
    const { repository, ...patch } = ProjectPatchSchema.parse(await readJson(c));
    const actor = c.get("actor");
    checkPatch(d, actor, before, patch);
    const repoChanges = repository !== undefined && repository !== before.fullName;
    if (repoChanges && repository !== null) {
      checkRepository(projects, repository, before.id);
    }
    // Last before the writes: everything else in the patch has passed.
    const applied = d.deployHost
      ? applyDeployHost(d.deployHost, actor, before, patched(before, patch))
      : null;
    if (repoChanges) {
      projects.setRepository(before.id, repository === null ? null : "github", repository);
    }
    const after = projects.update(before.id, {
      ...patch,
      ...(patch.enabled === true ? { disabledReason: null } : {}),
    });
    if (!after) {
      throw notFound(`no such project: ${before.slug}`);
    }
    recordPatch(audit, actor, before, after);
    return c.json({
      project: after,
      ...(applied && Object.keys(applied.renamed).length > 0 ? { renamed: applied.renamed } : {}),
      ...(applied?.claimed ? { domain: applied.claimed } : {}),
    });
  });

  api.delete("/projects/:ref", requirePermission("repos.manage"), (c) => {
    const before = findProject(projects, c.req.param("ref"));
    projects.delete(before.id);
    audit.record(c.get("actor"), "project.deleted", before.id, {
      old: auditFields(before),
      new: null,
    });
    return c.body(null, 204);
  });

  projectSecretRoutes(api, d);
  projectPullRoutes(api, d);
}

/** The fields that decide its addresses, as the patch would leave them. */
function patched(before: Project, patch: Omit<ProjectPatchRequest, "repository">): Project {
  return {
    ...before,
    slug: patch.slug ?? before.slug,
    domain: patch.domain === undefined ? before.domain : patch.domain,
    deployHost: patch.deployHost === undefined ? before.deployHost : patch.deployHost,
  };
}

function recordPatch(audit: AuditSink, actor: Actor, before: Project, after: Project): void {
  audit.record(actor, "project.updated", before.id, {
    old: auditFields(before),
    new: auditFields(after),
  });
  if (after.domain !== before.domain) {
    audit.record(actor, "project.domain", before.id, { old: before.domain, new: after.domain });
  }
}

function checkPatch(
  d: ProjectRouteDeps,
  actor: Actor,
  before: Project,
  patch: Omit<ProjectPatchRequest, "repository">,
): void {
  if (patch.ttl !== undefined && patch.ttl !== null && parseDuration(patch.ttl) === null) {
    throw unprocessable(`ttl ${JSON.stringify(patch.ttl)} is not a duration like 12h or 7d`);
  }
  checkTemplate(d, patch.templateId);
  if (patch.watermark !== undefined && !can(actor, "previews.watermark")) {
    throw forbidden('switching the gangway watermark needs "previews.watermark"');
  }
  if (patch.domain !== undefined) {
    if (!can(actor, "repos.domains")) {
      throw forbidden('choosing a repository\'s domain needs "repos.domains"');
    }
    if (patch.domain !== null) {
      d.domains?.assertAvailable(patch.domain, before.id);
    }
  }
  // A deploy branch hands the project's production preview to its pushes.
  const branchChanges =
    (patch.deployBranch !== undefined && patch.deployBranch !== before.deployBranch) ||
    (patch.deployHost !== undefined && patch.deployHost !== before.deployHost);
  if (branchChanges && !can(actor, "repos.domains")) {
    throw forbidden(
      'choosing the branch a repository deploys as production, or its address, needs "repos.domains"',
    );
  }
  if (patch.slug !== undefined && patch.slug !== before.slug) {
    checkSlugFree(d.projects, patch.slug);
  }
}

// Slugs are unique on the whole server; another org's project is not named.
function checkSlugFree(projects: ProjectsRepo, slug: string): void {
  const taken = acrossOrgs(() => projects.getBySlug(slug));
  if (!taken) {
    return;
  }
  if (!projects.get(taken.id)) {
    throw conflict(`slug "${slug}" is taken`, { slug });
  }
  throw conflict(`slug "${slug}" is taken by project "${taken.name}"`, { takenBy: taken.slug });
}

function findProject(projects: ProjectsRepo, ref: string): Project {
  const p = projects.find(ref);
  if (!p) {
    throw notFound(`no such project: ${ref}`);
  }
  return p;
}

function projectSecretRoutes(api: Hono<AppEnv>, d: ProjectRouteDeps): void {
  const deps = () => {
    if (!d.secrets || !d.previews) {
      throw notFound("secrets are not available on this server");
    }
    return { secrets: d.secrets, previews: d.previews };
  };
  api.get("/projects/:ref/env", requirePermission("repos.secrets"), (c) => {
    const project = findProject(d.projects, c.req.param("ref"));
    if (!d.secrets) {
      return c.json({ secrets: [] });
    }
    return c.json({ secrets: listSecrets(deps(), c.get("actor"), { kind: "project", project }) });
  });

  api.patch("/projects/:ref/env", requirePermission("repos.secrets"), async (c) => {
    const project = findProject(d.projects, c.req.param("ref"));
    const patch = EnvPatchSchema.parse(await readJson(c));
    return c.json(changeSecrets(deps(), c.get("actor"), { kind: "project", project }, patch));
  });
}

function uploadRequest(c: Context<AppEnv>): Extract<PullDeployRequest, { archive: unknown }> {
  const { sha, port } = PullUploadQuerySchema.parse(c.req.query());
  const archive = c.req.raw.body;
  if (!archive) {
    throw badRequest("the request has no body; send the tar or tar.gz as the body");
  }
  return { archive, sha, port };
}

function projectPullRoutes(api: Hono<AppEnv>, d: ProjectRouteDeps): void {
  api.get("/projects/:ref/workflow", requirePermission("previews.read"), (c) => {
    const project = findProject(d.projects, c.req.param("ref"));
    const port = Number(c.req.query("port") ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw unprocessable("port must be 1-65535");
    }
    const on = c.req.query("on") ?? "pull_request";
    if (on !== "pull_request" && on !== "push") {
      throw unprocessable('on is "pull_request" or "push"');
    }
    c.header("content-type", "text/yaml; charset=utf-8");
    if (on === "push") {
      if (project.deployBranch === null) {
        throw conflict(`project "${project.slug}" has no deploy branch; choose one first`);
      }
      c.header("x-gangway-path", PUSH_WORKFLOW_PATH_IN_REPO);
      return c.body(
        pushWorkflowFor({ ...project, deployBranch: project.deployBranch }, d.apiOrigin?.() ?? ""),
      );
    }
    c.header("x-gangway-path", WORKFLOW_PATH_IN_REPO);
    return c.body(workflowFor(project, d.apiOrigin?.() ?? "", port));
  });

  api.put("/projects/:ref/branch", requirePermission("previews.deploy"), async (c) => {
    if (!d.branches || !d.wire) {
      throw notFound("branch deploys are not available on this server");
    }
    if (!isTarballRequest(c)) {
      throw unprocessable(
        "a branch deploy is rebuilt in place from its source: send the branch's files as a tar or tar.gz body",
      );
    }
    const out = await d.branches.deploy(c.req.param("ref"), uploadRequest(c), c.get("actor"));
    if (out.action === "unchanged") {
      return c.json({ preview: d.wire(out.preview), unchanged: true });
    }
    if (c.req.query("wait") === "true") {
      const { preview, ok } = await out.done;
      return c.json({ preview: d.wire(preview) }, ok ? 201 : 502);
    }
    return c.json({ preview: d.wire(out.preview) }, 202);
  });

  api.put("/projects/:ref/pulls/:n", requirePermission("previews.deploy"), async (c) => {
    if (!d.pulls || !d.wire) {
      throw notFound("pull request previews are not available on this server");
    }
    const n = pullNumber(c.req.param("n"));
    const req = isTarballRequest(c) ? uploadRequest(c) : PullDeploySchema.parse(await readJson(c));
    const out = await d.pulls.deploy(c.req.param("ref"), n, req, c.get("actor"));
    if (out.action === "unchanged") {
      return c.json({ preview: d.wire(out.preview), unchanged: true });
    }
    if (c.req.query("wait") === "true") {
      const final = await out.result.done;
      return c.json({ preview: d.wire(final) }, final.state === "awake" ? 201 : 502);
    }
    return c.json({ preview: d.wire(out.result.preview) }, 202);
  });

  api.delete("/projects/:ref/pulls/:n", requirePermission("previews.destroy"), async (c) => {
    if (!d.pulls) {
      throw notFound("pull request previews are not available on this server");
    }
    await d.pulls.close(c.req.param("ref"), pullNumber(c.req.param("n")), c.get("actor"));
    return c.body(null, 204);
  });
}

function pullNumber(s: string): number {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) {
    throw badRequest("a pull request number is a positive integer");
  }
  return n;
}
