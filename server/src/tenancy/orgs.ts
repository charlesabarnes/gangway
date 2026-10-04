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
  if (d.orgs.bySlug(req.slug)) {
    throw conflict(`an org called "${req.slug}" already exists`, { slug: req.slug });
  }
  const now = (d.now ?? Date.now)();
  const org = d.db.transaction(() => {
    const made = d.orgs.create({ id: ulid(now), slug: req.slug, name: req.name });
    d.roles.copyBuiltins(made.id, () => ulid(now), now);
    d.templates.copyDefault(made.id, `d${made.id.toLowerCase()}`, now);
    return made;
  });
  d.permissions.reload();
  d.audit.record(actor, "org.created", org.id, { new: { slug: org.slug, name: org.name } });
  return org;
}
