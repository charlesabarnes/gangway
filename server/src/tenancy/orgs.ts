import type { Org, OrgCreateRequest } from "@gangway/shared/orgs-api";
import type { AuditSink } from "../audit/audit.ts";
import type { Actor } from "../auth/actor.ts";
import type { RolePermissions } from "../auth/roles.ts";
import type { OrgsRepo } from "../db/repos/orgs.ts";
import type { RolesRepo } from "../db/repos/roles.ts";
import type { TemplatesRepo } from "../db/repos/templates.ts";
import type { Db } from "../db/types.ts";
import { conflict } from "../errors.ts";
import { ulid } from "../util/ulid.ts";

export type OrgDeps = {
  db: Db;
  orgs: OrgsRepo;
  roles: RolesRepo;
  templates: TemplatesRepo;
  permissions: RolePermissions;
  audit: AuditSink;
  now?: () => number;
};

/** A new org, with its own builtin roles and default template copied from the home org's. */
export function createOrg(d: OrgDeps, actor: Actor, req: OrgCreateRequest): Org {
  const now = (d.now ?? Date.now)();
  const { org } = d.db.transaction(() => insertOrg(d, req, now));
  d.permissions.reload();
  d.audit.record(actor, "org.created", org.id, { new: { slug: org.slug, name: org.name } });
  return org;
}

/** The rows of a new org; call it inside a transaction, then reload the role permissions. */
export function insertOrg(
  d: Pick<OrgDeps, "orgs" | "roles" | "templates">,
  req: OrgCreateRequest,
  now: number,
): { org: Org; roles: Record<string, string> } {
  if (d.orgs.bySlug(req.slug)) {
    throw conflict(`an org called "${req.slug}" already exists`, { slug: req.slug });
  }
  const org = d.orgs.create({ id: ulid(now), slug: req.slug, name: req.name });
  const roles = d.roles.copyBuiltins(org.id, () => ulid(now), now);
  d.templates.copyDefault(org.id, `d${org.id.toLowerCase()}`, now);
  return { org, roles };
}
