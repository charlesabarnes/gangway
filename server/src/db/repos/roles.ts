import type { Role } from "@gangway/shared/domain";
import { ADMIN_ROLE_ID, isPermission, type Permission } from "@gangway/shared/permissions";
import type { Db } from "../types.ts";
import { rowToRole, type RoleRow } from "./mappers.ts";

/**
 * Roles and the role -> permission matrix (ADR-0009). The matrix is the operator's data;
 * the catalogue of what CAN be granted is code, synced into `permissions` at boot.
 */
export class RolesRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  list(): Role[] {
    return this.#db
      .query<RoleRow>("SELECT * FROM roles ORDER BY builtin DESC, name")
      .map(rowToRole);
  }

  get(id: string): Role | undefined {
    const r = this.#db.get<RoleRow>("SELECT * FROM roles WHERE id = $id", { id });
    return r ? rowToRole(r) : undefined;
  }

  /**
   * The whole matrix. A grant naming a permission the code no longer knows is dropped
   * here, not served: nothing checks it, so it must not look like it means something.
   */
  grants(): Map<string, Permission[]> {
    const out = new Map<string, Permission[]>();
    for (const role of this.list()) out.set(role.id, []);
    for (const r of this.#db.query<{ role_id: string; permission_id: string }>(
      "SELECT role_id, permission_id FROM role_permissions ORDER BY role_id, permission_id",
    )) {
      if (isPermission(r.permission_id)) out.get(r.role_id)?.push(r.permission_id);
    }
    return out;
  }

  /** Replace, not merge: what is passed is exactly what the role holds afterwards. */
  setPermissions(roleId: string, permissions: readonly Permission[]): void {
    this.#db.transaction(() => {
      this.#db.run("DELETE FROM role_permissions WHERE role_id = $r", { r: roleId });
      for (const p of new Set(permissions)) {
        this.#db.run("INSERT INTO role_permissions (role_id, permission_id) VALUES ($r, $p)", {
          r: roleId,
          p,
        });
      }
    });
  }

  /**
   * Boot-time: make the table agree with the code. A permission added in a later phase
   * appears here (and is granted to `admin`, so the table stays truthful for anyone
   * querying it) without a migration. Nothing is ever deleted: a grant on a retired id is
   * inert, and deleting it would silently lose an operator's decision if the id came back.
   */
  syncCatalogue(catalogue: readonly { id: string; feature: string; description: string }[]): {
    added: string[];
  } {
    const added: string[] = [];
    this.#db.transaction(() => {
      const known = new Set(
        this.#db.query<{ id: string }>("SELECT id FROM permissions").map((r) => r.id),
      );
      for (const p of catalogue) {
        if (!known.has(p.id)) added.push(p.id);
        this.#db.run(
          `INSERT INTO permissions (id, feature, description) VALUES ($id, $feature, $description)
           ON CONFLICT(id) DO UPDATE SET feature = excluded.feature, description = excluded.description`,
          { id: p.id, feature: p.feature, description: p.description },
        );
        this.#db.run(
          "INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES ($r, $p)",
          { r: ADMIN_ROLE_ID, p: p.id },
        );
      }
    });
    return { added };
  }
}
