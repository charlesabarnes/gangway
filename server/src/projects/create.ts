// Making a project, shared by POST /v1/projects and the MCP project tool so the two cannot drift.
import type { ProjectCreateRequest } from "@gangway/shared/api";
import type { Project } from "@gangway/shared/domain";
import { slugify } from "@gangway/shared/hostname";
import type { AuditSink } from "../audit/audit.ts";
import type { Actor } from "../auth/actor.ts";
import type { ProjectsRepo } from "../db/repos/projects.ts";
import type { TemplatesRepo } from "../db/repos/templates.ts";
import { conflict, unprocessable } from "../errors.ts";
import { trimEndChar } from "../util/text.ts";
import { ulid } from "../util/ulid.ts";
import { acrossOrgs } from "../tenancy/scope.ts";

export const MAX_SLUG = 24;

export type CreateProjectDeps = {
  projects: ProjectsRepo;
  audit: AuditSink;
  templates?: Pick<TemplatesRepo, "get"> | undefined;
};

export function checkTemplate(d: CreateProjectDeps, id: string | null | undefined): void {
  if (id !== undefined && id !== null && !d.templates?.get(id)) {
    throw unprocessable(`no such template: ${id}`, { templateId: id });
  }
}

// A repository belongs to one project on the whole server; another org's is not named.
export function checkRepository(projects: ProjectsRepo, full: string, self?: string): void {
  const taken = acrossOrgs(() => projects.getByFullName("github", full));
  if (!taken || taken.id === self) {
    return;
  }
  if (!projects.get(taken.id)) {
    throw conflict(`${full} is already connected to another gangway org`);
  }
  throw conflict(`${full} is already project "${taken.slug}"`, { takenBy: taken.slug });
}

export function createProject(
  d: CreateProjectDeps,
  actor: Actor,
  req: ProjectCreateRequest,
): Project {
  const { projects } = d;
  const slug = req.slug ?? trimEndChar(slugify(req.name).slice(0, MAX_SLUG), "-");
  if (!slug) {
    throw unprocessable("the name has no usable characters for a slug; give one");
  }
  if (acrossOrgs(() => projects.getBySlug(slug))) {
    throw conflict(`slug "${slug}" is taken`, { slug });
  }
  if (req.repository) {
    checkRepository(projects, req.repository);
  }
  checkTemplate(d, req.templateId);
  const project = projects.create({
    id: ulid(),
    orgId: actor.orgId,
    name: req.name,
    slug,
    ...(req.repository ? { forge: "github" as const, fullName: req.repository } : {}),
    prTrigger: req.prTrigger ?? "workflow",
    templateId: req.templateId ?? null,
  });
  d.audit.record(actor, "project.created", project.id, { old: null, new: auditFields(project) });
  return project;
}

export const auditFields = (p: Project) => ({
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
  watermark: p.watermark,
  deployBranch: p.deployBranch,
});
