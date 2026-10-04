import { must } from "@gangway/shared/must";
import type { User } from "@gangway/shared/domain";
import { ADMIN_ROLE_ID } from "@gangway/shared/permissions";
import type { Db } from "../types.ts";
import { bool, num } from "./mappers.ts";

// Sessions, tokens and grants join users and map the owner with these too.
export const USER_COLUMNS = "id, email, role_id, disabled, invited, created_at";
export type UserRow = {
  id: string;
  email: string;
  role_id: string;
  disabled: number;
  invited: number;
  created_at: number;
};

export const rowToUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  roleId: r.role_id,
  disabled: bool(r.disabled),
  invited: bool(r.invited),
  createdAt: new Date(r.created_at),
});

export type UserCredentials = { hash: string; salt: string };

export type CreateUser = {
  id: string;
  email: string;
  roleId: string;
  invited?: boolean;
  ssoOnly?: boolean;
} & UserCredentials;

// Emails arrive trimmed and lowercased; the UNIQUE column has no NOCASE collation.
export class UsersRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  create(u: CreateUser): User {
    this.#db.run(
      `INSERT INTO users (id, email, password_hash, password_salt, role_id, disabled, invited, sso_only, created_at)
       VALUES ($id, $email, $hash, $salt, $role, 0, $invited, $ssoOnly, $now)`,
      {
        id: u.id,
        email: u.email,
        hash: u.hash,
        salt: u.salt,
        role: u.roleId,
        invited: num(u.invited === true),
        ssoOnly: num(u.ssoOnly === true),
        now: this.#now(),
      },
    );
    this.#db.run(
      `INSERT INTO memberships (org_id, user_id, role_id, created_at)
       VALUES ((SELECT id FROM orgs WHERE home = 1), $id, $role, $now)`,
      { id: u.id, role: u.roleId, now: this.#now() },
    );
    return must(this.get(u.id), "the user just saved");
  }

  get(id: string): User | undefined {
    const r = this.#db.get(`SELECT ${USER_COLUMNS} FROM users WHERE id = $id`, { id }) as
      UserRow | undefined;
    return r ? rowToUser(r) : undefined;
  }

  getByEmail(email: string): User | undefined {
    const r = this.#db.get(`SELECT ${USER_COLUMNS} FROM users WHERE email = $email`, {
      email,
    }) as UserRow | undefined;
    return r ? rowToUser(r) : undefined;
  }

  credentials(id: string): UserCredentials | undefined {
    const r = this.#db.get("SELECT password_hash, password_salt FROM users WHERE id = $id", {
      id,
    }) as { password_hash: string; password_salt: string } | undefined;
    return r ? { hash: r.password_hash, salt: r.password_salt } : undefined;
  }

  list(): User[] {
    return (
      this.#db.query(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at, id`) as UserRow[]
    ).map(rowToUser);
  }

  count(): number {
    return must(
      this.#db.get("SELECT COUNT(*) AS n FROM users") as { n: number } | undefined,
      "a count row",
    ).n;
  }

  update(id: string, patch: { roleId?: string; disabled?: boolean }): User | undefined {
    if (patch.roleId !== undefined) {
      this.#db.run("UPDATE users SET role_id = $r WHERE id = $id", { id, r: patch.roleId });
      this.#db.run(
        "UPDATE memberships SET role_id = $r WHERE user_id = $id AND org_id = (SELECT id FROM orgs WHERE home = 1)",
        { id, r: patch.roleId },
      );
    }
    if (patch.disabled !== undefined) {
      this.#db.run("UPDATE users SET disabled = $d WHERE id = $id", { id, d: num(patch.disabled) });
    }
    return this.get(id);
  }

  /** Signs in only through the identity provider, so no emailed link may set a password. */
  isSsoOnly(id: string): boolean {
    const r = this.#db.get("SELECT sso_only FROM users WHERE id = $id", { id }) as
      { sso_only: number } | undefined;
    return r?.sso_only === 1;
  }

  /** Also ends an invitation, and SSO-only: the account now has a password someone chose. */
  setPassword(id: string, c: UserCredentials): void {
    this.#db.run(
      "UPDATE users SET password_hash = $hash, password_salt = $salt, invited = 0, sso_only = 0 WHERE id = $id",
      {
        id,
        hash: c.hash,
        salt: c.salt,
      },
    );
  }

  /** An invited account that signs in through its identity provider has accepted the invitation. */
  clearInvited(id: string): void {
    this.#db.run("UPDATE users SET invited = 0 WHERE id = $id", { id });
  }

  countActiveAdmins(exceptId?: string): number {
    const row = this.#db.get(
      "SELECT COUNT(*) AS n FROM users WHERE role_id = $admin AND disabled = 0 AND id != $except",
      { admin: ADMIN_ROLE_ID, except: exceptId ?? "" },
    ) as { n: number } | undefined;
    return must(row, "a count row").n;
  }
}
