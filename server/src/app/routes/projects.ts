import type { Hono } from "hono";
import {
  EnvPatchSchema,
  ProjectCreateSchema,
  ProjectPatchSchema,
  PullDeploySchema,
} from "@gangway/shared/api";
import { slugify } from "@gangway/shared/hostname";
import type { Preview, Project } from "@gangway/shared/domain";
import type { AuditSink } from "../../audit/audit.ts";
import type { ProjectsRepo } from "../../db/repos/projects.ts";
import type { TemplatesRepo } from "../../db/repos/templates.ts";
import { badRequest, conflict, notFound, unprocessable } from "../../errors.ts";
import { readJson } from "../problem.ts";
import type { PreviewUrl } from "../../previews/deploy.ts";
import type { Pulls } from "../../projects/pulls.ts";
import { WORKFLOW_PATH_IN_REPO, workflowFor } from "../../projects/workflow.ts";
import type { Secrets } from "../../secrets/secrets.ts";
import { parseDuration } from "../../util/duration.ts";
import { ulid } from "../../util/ulid.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

export type ProjectRouteDeps = {
  projects: ProjectsRepo;
  audit: AuditSink;
  secrets?: Secrets | undefined;
  templates?: Pick<TemplatesRepo, "get"> | undefined;
  pulls?: Pulls | undefined;
  wire?: ((p: Preview) => Preview & { urls: PreviewUrl[] }) | undefined;
  apiOrigin?: (() => string) | undefined;
};

const MAX_SLUG = 24;

export function projectRoutes(api: Hono<AppEnv>, d: ProjectRouteDeps): void {
  const { projects, audit } = d;
  const checkTemplate = (id: string | null | undefined) => {
    if (id !== undefined && id !== null && !d.templates?.get(id))
      throw unprocessable(`no such template: ${id}`, { templateId: id });
  };
  const checkRepository = (full: string, self?: string) => {
    const taken = projects.getByFullName("github", full);
    if (taken && taken.id !== self)
      throw conflict(`${full} is already project "${taken.slug}"`, { takenBy: taken.slug });
  };

  api.get("/projects", requirePermission("previews.read"), (c) =>
    c.json({ projects: projects.list() }),
  );

  api.get("/projects/:ref", requirePermission("previews.read"), (c) =>
    c.json({ project: findProject(projects, c.req.param("ref")) }),
  );

  api.post("/projects", requirePermission("repos.manage"), async (c) => {
    const req = ProjectCreateSchema.parse(await readJson(c));
    const slug = req.slug ?? slugify(req.name).slice(0, MAX_SLUG).replace(/-+$/, "");
    if (!slug) throw unprocessable("the name has no usable characters for a slug; give one");
    if (projects.getBySlug(slug)) throw conflict(`slug "${slug}" is taken`, { slug });
    if (req.repository) checkRepository(req.repository);
    checkTemplate(req.templateId);
    const project = projects.create({
      id: ulid(),
      name: req.name,
      slug,
      ...(req.repository ? { forge: "github" as const, fullName: req.repository } : {}),
      prTrigger: req.prTrigger ?? "workflow",
      templateId: req.templateId ?? null,
    });
    audit.record(c.get("actor"), "project.created", project.id, { old: null, new: pick(project) });
    return c.json({ project }, 201);
  });

  api.patch("/projects/:ref", requirePermission("repos.manage"), async (c) => {
    const before = findProject(projects, c.req.param("ref"));
    const { repository, ...patch } = ProjectPatchSchema.parse(await readJson(c));
    if (patch.ttl !== undefined && patch.ttl !== null && parseDuration(patch.ttl) === null)
      throw unprocessable(`ttl ${JSON.stringify(patch.ttl)} is not a duration like 12h or 7d`);
    checkTemplate(patch.templateId);
    if (patch.slug !== undefined && patch.slug !== before.slug) {
      const taken = projects.getBySlug(patch.slug);
      if (taken)
        throw conflict(`slug "${patch.slug}" is taken by project "${taken.name}"`, {
          takenBy: taken.slug,
        });
    }
    if (repository !== undefined && repository !== before.fullName) {
      if (repository !== null) checkRepository(repository, before.id);
      projects.setRepository(before.id, repository === null ? null : "github", repository);
    }
    const after = projects.update(before.id, {
      ...patch,
      ...(patch.enabled === true ? { disabledReason: null } : {}),
    })!;
    audit.record(c.get("actor"), "project.updated", before.id, {
      old: pick(before),
      new: pick(after),
    });
    return c.json({ project: after });
  });

  api.delete("/projects/:ref", requirePermission("repos.manage"), (c) => {
    const before = findProject(projects, c.req.param("ref"));
    projects.delete(before.id);
    audit.record(c.get("actor"), "project.deleted", before.id, { old: pick(before), new: null });
    return c.body(null, 204);
  });

  projectSecretRoutes(api, d);
  projectPullRoutes(api, d);
}

function findProject(projects: ProjectsRepo, ref: string): Project {
  const p = projects.find(ref);
  if (!p) throw notFound(`no such project: ${ref}`);
  return p;
}

function projectSecretRoutes(api: Hono<AppEnv>, d: ProjectRouteDeps): void {
  api.get("/projects/:ref/env", requirePermission("repos.secrets"), (c) => {
    const project = findProject(d.projects, c.req.param("ref"));
    return c.json({ secrets: d.secrets ? d.secrets.project(project.id).list() : [] });
  });

  api.patch("/projects/:ref/env", requirePermission("repos.secrets"), async (c) => {
    const project = findProject(d.projects, c.req.param("ref"));
    if (!d.secrets) throw notFound("secrets are not available on this server");
    const patch = EnvPatchSchema.parse(await readJson(c));
    return c.json({ secrets: d.secrets.project(project.id).update(c.get("actor"), patch) });
  });
}

function projectPullRoutes(api: Hono<AppEnv>, d: ProjectRouteDeps): void {
  api.get("/projects/:ref/workflow", requirePermission("previews.read"), (c) => {
    const project = findProject(d.projects, c.req.param("ref"));
    const port = Number(c.req.query("port") ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw unprocessable("port must be 1-65535");
    c.header("content-type", "text/yaml; charset=utf-8");
    c.header("x-gangway-path", WORKFLOW_PATH_IN_REPO);
    return c.body(workflowFor(project, d.apiOrigin?.() ?? "", port));
  });

  api.put("/projects/:ref/pulls/:n", requirePermission("previews.deploy"), async (c) => {
    if (!d.pulls || !d.wire)
      throw notFound("pull request previews are not available on this server");
    const n = pullNumber(c.req.param("n"));
    const req = PullDeploySchema.parse(await readJson(c));
    const out = await d.pulls.deploy(c.req.param("ref"), n, req, c.get("actor"));
    if (out.action === "unchanged")
      return c.json({ preview: d.wire(out.preview), unchanged: true });
    if (c.req.query("wait") === "true") {
      const final = await out.result.done;
      return c.json({ preview: d.wire(final) }, final.state === "awake" ? 201 : 502);
    }
    return c.json({ preview: d.wire(out.result.preview) }, 202);
  });

  api.delete("/projects/:ref/pulls/:n", requirePermission("previews.destroy"), async (c) => {
    if (!d.pulls) throw notFound("pull request previews are not available on this server");
    await d.pulls.close(c.req.param("ref"), pullNumber(c.req.param("n")), c.get("actor"));
    return c.body(null, 204);
  });
}

function pullNumber(s: string): number {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1)
    throw badRequest("a pull request number is a positive integer");
  return n;
}

const pick = (p: Project) => ({
  name: p.name,
  slug: p.slug,
  repository: p.fullName,
  prTrigger: p.prTrigger,
  enabled: p.enabled,
  templateId: p.templateId,
  visibility: p.visibility,
  ttl: p.ttl,
  forks: p.forks,
  drafts: p.drafts,
  prClearance: p.prClearance,
  forkClearance: p.forkClearance,
});
