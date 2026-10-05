import type { User } from "@gangway/shared/domain";
import { must } from "@gangway/shared/must";
import type { Org, OrgLimits } from "@gangway/shared/orgs-api";
import type { AuditSink } from "../audit/audit.ts";
import type { RolePermissions } from "../auth/roles.ts";
import type { SsoIdentity } from "../auth/sso.ts";
import type { OrgsRepo } from "../db/repos/orgs.ts";
import type { RolesRepo } from "../db/repos/roles.ts";
import type { TemplatesRepo } from "../db/repos/templates.ts";
import type { UserIdentitiesRepo } from "../db/repos/user-identities.ts";
import type { UserCredentials, UsersRepo } from "../db/repos/users.ts";
import { ulid } from "../util/ulid.ts";
import { insertOrg } from "./orgs.ts";

/** Who may sign up, and what their org may use; null while signup is off. */
export type SignupPolicy = { issuer: string; limits: OrgLimits };

export type SignupDeps = {
  policy: () => SignupPolicy | null;
  orgs: OrgsRepo;
  roles: RolesRepo;
  templates: TemplatesRepo;
  users: UsersRepo;
  identities: UserIdentitiesRepo;
  permissions: RolePermissions;
  audit: AuditSink;
  now?: () => number;
};

const SLUG_MAX = 20;
const sameIssuer = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

export function slugFor(email: string, taken: (slug: string) => boolean): string {
  const base = (email.split("@")[0] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "") || "org";
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : String(n);
    const slug = base.slice(0, SLUG_MAX - suffix.length) + suffix;
    if (!taken(slug)) {
      return slug;
    }
  }
}

export class Signup {
  readonly #d: SignupDeps;

  constructor(d: SignupDeps) {
    this.#d = d;
  }

  allows(issuer: string): boolean {
    const p = this.#d.policy();
    return p !== null && p.issuer !== "" && sameIssuer(p.issuer, issuer);
  }

  /** Inside the sign-in's transaction: the person, their org and its limits; then `created`. */
  create(identity: SsoIdentity, credentials: UserCredentials): { user: User; org: Org } {
    const { orgs, users, identities } = this.#d;
    const limits = must(this.#d.policy(), "signup was allowed").limits;
    const now = (this.#d.now ?? Date.now)();
    const slug = slugFor(identity.email, (s) => orgs.bySlug(s) !== undefined);
    const { org, roles } = insertOrg(this.#d, { slug, name: identity.email.slice(0, 64) }, now);
    orgs.setLimits(org.id, null, limits, "signup");
    const user = users.create({
      id: ulid(now),
      email: identity.email,
      roleId: must(roles["admin"], "the org's admin role"),
      orgId: org.id,
      ssoOnly: true,
      ...credentials,
    });
    identities.link(identity.issuer, identity.subject, user.id);
    return { user, org };
  }

  created({ user, org }: { user: User; org: Org }): void {
    this.#d.permissions.reload();
    this.#d.audit.record(null, "org.created", org.id, {
      new: { slug: org.slug, name: org.name, signup: user.id },
    });
    this.#d.audit.record(null, "user.created", user.id, {
      new: { email: user.email, roleId: user.roleId, sso: true, orgId: org.id },
    });
  }
}
