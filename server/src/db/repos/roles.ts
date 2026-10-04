import type { Role } from "@gangway/shared/domain";
import { isPermission, type Permission } from "@gangway/shared/permissions";
import { orgFilter } from "../../tenancy/scope.ts";
import type { Db } from "../types.ts";
import { rowToRole, type RoleRow } from "./mappers.ts";

export class RolesRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  list(): Role[] {
    const o = orgFilter();
    return (
      this.#db.query(
        `SELECT * FROM roles WHERE ${o.sql} ORDER BY builtin DESC, name`,
        o.params,
      ) as RoleRow[]
    ).map(rowToRole);
  }

  get(id: string): Role | undefined {
    const o = orgFilter();
    const r = this.#db.get(`SELECT * FROM roles WHERE id = $id AND ${o.sql}`, {
      id,
      ...o.params,
    }) as RoleRow | undefined;
    return r ? rowToRole(r) : undefined;
  }

  /** Every org's admin role: admin is known by its kind, not its id. */
  adminIds(): Set<string> {
    return new Set(
      (this.#db.query("SELECT id FROM roles WHERE kind = 'admin'") as { id: string }[]).map(
        (r) => r.id,
      ),
    );
  }

  /** Gives a new org the home org's builtin roles, with their grants; their ids by kind. */
  copyBuiltins(orgId: string, newId: () => string, now: number): Record<string, string> {
    const ids: Record<string, string> = {};
    const builtins = this.#db.query(
      "SELECT * FROM roles WHERE kind IS NOT NULL AND org_id = (SELECT id FROM orgs WHERE home = 1)",
    ) as (RoleRow & { kind: string })[];
    for (const r of builtins) {
      const id = newId();
      ids[r.kind] = id;
      this.#db.run(
        `INSERT INTO roles (id, org_id, name, description, builtin, kind, created_at)
         VALUES ($id, $org, $name, $description, 1, $kind, $now)`,
        { id, org: orgId, name: r.name, description: r.description, kind: r.kind, now },
      );
      this.#db.run(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT $id, permission_id FROM role_permissions WHERE role_id = $from`,
        { id, from: r.id },
      );
    }
    return ids;
  }

  grants(): Map<string, Permission[]> {
    // Every org's, whoever asks: one matrix answers for all.
    const out = new Map<string, Permission[]>();
    for (const r of this.#db.query("SELECT id FROM roles") as { id: string }[]) {
      out.set(r.id, []);
    }
    for (const r of this.#db.query(
      "SELECT role_id, permission_id FROM role_permissions ORDER BY role_id, permission_id",
    ) as { role_id: string; permission_id: string }[]) {
      if (isPermission(r.permission_id)) {
        out.get(r.role_id)?.push(r.permission_id);
      }
    }
    return out;
  }

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

  // Never deletes: a grant on a retired id is inert and should survive if the id returns.
  syncCatalogue(catalogue: readonly { id: string; feature: string; description: string }[]): {
    added: string[];
  } {
    const added: string[] = [];
    this.#db.transaction(() => {
      const known = new Set(
        (this.#db.query("SELECT id FROM permissions") as { id: string }[]).map((r) => r.id),
      );
      for (const p of catalogue) {
        if (!known.has(p.id)) {
          added.push(p.id);
        }
        this.#db.run(
          `INSERT INTO permissions (id, feature, description) VALUES ($id, $feature, $description)
           ON CONFLICT(id) DO UPDATE SET feature = excluded.feature, description = excluded.description`,
          { id: p.id, feature: p.feature, description: p.description },
        );
        this.#db.run(
          `INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
           SELECT id, $p FROM roles WHERE kind = 'admin'`,
          { p: p.id },
        );
      }
    });
    return { added };
  }
}
