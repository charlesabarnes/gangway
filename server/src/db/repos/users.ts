import type { User } from "@gangway/shared/domain";
import { ADMIN_ROLE_ID } from "@gangway/shared/permissions";
import type { Db } from "../types.ts";
import { USER_COLUMNS, num, rowToUser, type UserRow } from "./mappers.ts";

/** Password material. Leaves this repo only through `credentials()`, never inside a `User`. */
export type UserCredentials = { hash: string; salt: string };

export type CreateUser = { id: string; email: string; roleId: string } & UserCredentials;

/**
 * Local accounts. `email` arrives already trimmed and lowercased (the zod schema does
 * it): the UNIQUE column has no NOCASE collation, so the repo compares bytes.
 *
 * There is no `delete`. An account is disabled, never removed: audit rows keep pointing at
 * a real person, and the ON DELETE CASCADE to their tokens never fires by accident.
 */
export class UsersRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  create(u: CreateUser): User {
    this.#db.run(
      `INSERT INTO users (id, email, password_hash, password_salt, role_id, disabled, created_at)
       VALUES ($id, $email, $hash, $salt, $role, 0, $now)`,
      { id: u.id, email: u.email, hash: u.hash, salt: u.salt, role: u.roleId, now: this.#now() },
    );
    return this.get(u.id)!;
  }

  get(id: string): User | undefined {
    const r = this.#db.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $id`, { id });
    return r ? rowToUser(r) : undefined;
  }

  getByEmail(email: string): User | undefined {
    const r = this.#db.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE email = $email`, {
      email,
    });
    return r ? rowToUser(r) : undefined;
  }

  credentials(id: string): UserCredentials | undefined {
    const r = this.#db.get<{ password_hash: string; password_salt: string }>(
      "SELECT password_hash, password_salt FROM users WHERE id = $id",
      { id },
    );
    return r ? { hash: r.password_hash, salt: r.password_salt } : undefined;
  }

  list(): User[] {
    return this.#db
      .query<UserRow>(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at, id`)
      .map(rowToUser);
  }

  count(): number {
    return this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users")!.n;
  }

  update(id: string, patch: { roleId?: string; disabled?: boolean }): User | undefined {
    if (patch.roleId !== undefined)
      this.#db.run("UPDATE users SET role_id = $r WHERE id = $id", { id, r: patch.roleId });
    if (patch.disabled !== undefined)
      this.#db.run("UPDATE users SET disabled = $d WHERE id = $id", { id, d: num(patch.disabled) });
    return this.get(id);
  }

  setPassword(id: string, c: UserCredentials): void {
    this.#db.run("UPDATE users SET password_hash = $hash, password_salt = $salt WHERE id = $id", {
      id,
      hash: c.hash,
      salt: c.salt,
    });
  }

  /**
   * Enabled accounts holding the builtin `admin` role, optionally not counting one. The
   * last-admin guard asks "who is left if this account stops being one?".
   */
  countActiveAdmins(exceptId?: string): number {
    return this.#db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM users WHERE role_id = $admin AND disabled = 0 AND id != $except",
      { admin: ADMIN_ROLE_ID, except: exceptId ?? "" },
    )!.n;
  }
}
