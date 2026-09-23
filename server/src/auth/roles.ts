import type { Role } from "@gangway/shared/domain";
import {
  ADMIN_ROLE_ID,
  ALL_PERMISSIONS,
  PERMISSIONS,
  type Permission,
} from "@gangway/shared/permissions";
import type { AuditSink } from "../audit/audit.ts";
import type { RolesRepo } from "../db/repos/roles.ts";
import { conflict, notFound } from "../errors.ts";
import type { Actor } from "./actor.ts";

const EVERYTHING: ReadonlySet<Permission> = new Set(ALL_PERMISSIONS);
const NOTHING: ReadonlySet<Permission> = new Set();

export class RolePermissions {
  readonly #repo: RolesRepo;
  readonly #audit: AuditSink | undefined;
  #matrix = new Map<string, ReadonlySet<Permission>>();

  constructor(repo: RolesRepo, audit?: AuditSink) {
    this.#repo = repo;
    this.#audit = audit;
    this.#repo.syncCatalogue(PERMISSIONS);
    this.reload();
  }

  reload(): void {
    this.#matrix = new Map([...this.#repo.grants()].map(([role, ps]) => [role, new Set(ps)]));
  }

  for(roleId: string): ReadonlySet<Permission> {
    // Admin is answered from code so no edit to the table can lock everyone out.
    if (roleId === ADMIN_ROLE_ID) return EVERYTHING;
    return this.#matrix.get(roleId) ?? NOTHING;
  }

  roles(): (Role & { permissions: Permission[]; editable: boolean })[] {
    return this.#repo.list().map((r) => ({
      ...r,
      permissions: [...this.for(r.id)].sort(),
      editable: r.id !== ADMIN_ROLE_ID,
    }));
  }

  set(
    roleId: string,
    permissions: readonly Permission[],
    actor: Actor | null = null,
  ): { old: Permission[]; new: Permission[] } {
    if (!this.#repo.get(roleId)) throw notFound(`no such role: ${roleId}`);
    if (roleId === ADMIN_ROLE_ID)
      throw conflict("the admin role always holds every permission and cannot be edited");
    const old = [...this.for(roleId)].sort();
    this.#repo.setPermissions(roleId, permissions);
    this.reload();
    const change = { old, new: [...this.for(roleId)].sort() };
    this.#audit?.record(actor, "role.permissions.changed", roleId, {
      old: { permissions: change.old },
      new: { permissions: change.new },
    });
    return change;
  }
}
