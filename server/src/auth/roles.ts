/**
 * The role -> permission matrix, in memory. Every request resolves an actor's permissions,
 * so that must be a Map lookup and not a query -- the same bargain the RouteTable makes:
 * SQLite is the truth, this is a write-through cache, and a write goes to both or neither.
 *
 * `admin` is answered from CODE, never from the table. No edit to the matrix -- through
 * the API, or by hand in SQLite -- can take a permission away from it, and a permission
 * added in a later phase belongs to it the moment the code knows about it. That is the
 * whole lockout guarantee, so it lives in one `if`.
 */
import type { Role } from "../../../shared/src/domain.ts";
import { ADMIN_ROLE_ID, ALL_PERMISSIONS, PERMISSIONS, type Permission } from "../../../shared/src/permissions.ts";
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

  /** An unknown role holds nothing: a user pointing at a role that vanished can do nothing, not everything. */
  for(roleId: string): ReadonlySet<Permission> {
    if (roleId === ADMIN_ROLE_ID) return EVERYTHING;
    return this.#matrix.get(roleId) ?? NOTHING;
  }

  roles(): (Role & { permissions: Permission[]; editable: boolean })[] {
    return this.#repo.list().map((r) => ({ ...r, permissions: [...this.for(r.id)].sort(), editable: r.id !== ADMIN_ROLE_ID }));
  }

  /**
   * Replace what a role grants. Takes effect on the NEXT request of everyone in the role,
   * and of every token they own: nothing about authority is cached in a session.
   * "Who let viewers destroy previews" is exactly the question asked later, so the whole
   * before-and-after goes to the audit log.
   */
  set(roleId: string, permissions: readonly Permission[], actor: Actor | null = null): { old: Permission[]; new: Permission[] } {
    if (!this.#repo.get(roleId)) throw notFound(`no such role: ${roleId}`);
    if (roleId === ADMIN_ROLE_ID) throw conflict("the admin role always holds every permission and cannot be edited");
    const old = [...this.for(roleId)].sort();
    this.#repo.setPermissions(roleId, permissions);
    this.reload();
    const change = { old, new: [...this.for(roleId)].sort() };
    this.#audit?.record(actor, "role.permissions.changed", roleId, { old: { permissions: change.old }, new: { permissions: change.new } });
    return change;
  }
}
