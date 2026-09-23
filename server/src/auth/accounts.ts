import type { User } from "@gangway/shared/domain";
import { ADMIN_ROLE_ID } from "@gangway/shared/permissions";
import type { AuditSink } from "../audit/audit.ts";
import type { RolesRepo } from "../db/repos/roles.ts";
import type { UsersRepo } from "../db/repos/users.ts";
import type { Db } from "../db/types.ts";
import {
  AppError,
  conflict,
  forbidden,
  notFound,
  rateLimited,
  unauthorized,
  unprocessable,
} from "../errors.ts";
import { ulid } from "../util/ulid.ts";
import type { Actor } from "./actor.ts";
import type { LoginLimiter } from "./limiter.ts";
import type { Passwords } from "./password.ts";
import type { Sessions } from "./sessions.ts";

export type RequestMeta = { ip: string; userAgent: string | null };
export type LoggedIn = { user: User; secret: string };

export type AccountsDeps = {
  db: Pick<Db, "transaction">;
  users: UsersRepo;
  roles: RolesRepo;
  sessions: Sessions;
  passwords: Passwords;
  limiter: LoginLimiter;
  audit: AuditSink;
  onCredentialsRevoked?: ((userId: string) => void) | undefined;
  now?: () => number;
};

const BAD_LOGIN = "wrong email or password";
const BLOCKED_NOTE_EVERY_MS = 15 * 60_000;

export class Accounts {
  readonly #d: AccountsDeps;
  readonly #now: () => number;
  readonly #blockedNoted = new Map<string, number>();

  constructor(d: AccountsDeps) {
    this.#d = d;
    this.#now = d.now ?? Date.now;
  }

  async login(email: string, password: string, meta: RequestMeta): Promise<LoggedIn> {
    const { users, passwords, limiter, audit, sessions } = this.#d;

    const verdict = limiter.check(meta.ip, email);
    if (!verdict.ok) {
      const key = verdict.reason === "ip" ? `ip:${meta.ip}` : `email:${email}`;
      const now = this.#now();
      if ((this.#blockedNoted.get(key) ?? 0) < now - BLOCKED_NOTE_EVERY_MS) {
        if (this.#blockedNoted.size > 10_000) this.#blockedNoted.clear();
        this.#blockedNoted.set(key, now);
        audit.record(null, "auth.login.blocked", email, {
          new: { ip: meta.ip, reason: verdict.reason, retryAfterSec: verdict.retryAfterSec },
        });
      }
      throw rateLimited(verdict.retryAfterSec, "too many failed logins; try again later");
    }

    const user = users.getByEmail(email);
    const usable = user && !user.disabled ? users.credentials(user.id) : undefined;
    const ok = usable
      ? await passwords.verify(password, usable)
      : await passwords.verifyDummy(password);
    if (!user || !usable || !ok) {
      limiter.fail(meta.ip, email);
      audit.record(null, "auth.login.failed", email, { new: { ip: meta.ip } });
      throw unauthorized(BAD_LOGIN);
    }

    limiter.succeed(email);
    if (passwords.needsRehash(usable.hash))
      users.setPassword(user.id, await passwords.hash(password));
    const { secret, session } = sessions.issue(user.id, meta);
    audit.record(
      {
        kind: "user",
        userId: user.id,
        roleId: user.roleId,
        permissions: new Set(),
        sessionId: session.id,
      },
      "auth.login",
      user.id,
      { new: { ip: meta.ip } },
    );
    return { user, secret };
  }

  async setupFirstAdmin(email: string, password: string, meta: RequestMeta): Promise<LoggedIn> {
    const { db, users, passwords, sessions, audit } = this.#d;
    // Db.transaction is synchronous, so hashing happens before it and nothing inside awaits.
    const credentials = await passwords.hash(password);
    const user = db.transaction(() => {
      if (users.count() > 0) throw notFound("not found");
      return users.create({ id: ulid(this.#now()), email, roleId: ADMIN_ROLE_ID, ...credentials });
    });
    const { secret } = sessions.issue(user.id, meta);
    audit.record(null, "auth.setup", user.id, {
      new: { email, roleId: ADMIN_ROLE_ID, ip: meta.ip },
    });
    return { user, secret };
  }

  listUsers(): User[] {
    return this.#d.users.list();
  }

  getUser(id: string): User | undefined {
    return this.#d.users.get(id);
  }

  async createUser(
    actor: Actor,
    input: { email: string; password: string; roleId: string },
  ): Promise<User> {
    const { db, users, roles, passwords, audit } = this.#d;
    if (!roles.get(input.roleId)) throw unprocessable(`no such role: ${input.roleId}`);
    const credentials = await passwords.hash(input.password);
    const user = db.transaction(() => {
      if (users.getByEmail(input.email))
        throw conflict("an account with that email already exists");
      return users.create({
        id: ulid(this.#now()),
        email: input.email,
        roleId: input.roleId,
        ...credentials,
      });
    });
    audit.record(actor, "user.created", user.id, {
      new: { email: user.email, roleId: user.roleId },
    });
    return user;
  }

  async updateUser(
    actor: Actor,
    id: string,
    patch: { roleId?: string; disabled?: boolean; password?: string },
  ): Promise<User> {
    const { db, users, roles, passwords, sessions, audit } = this.#d;
    if (patch.roleId !== undefined && !roles.get(patch.roleId))
      throw unprocessable(`no such role: ${patch.roleId}`);
    const credentials =
      patch.password === undefined ? undefined : await passwords.hash(patch.password);

    const { before, after } = db.transaction(() => {
      const before = users.get(id);
      if (!before) throw notFound(`no such user: ${id}`);
      // Checked inside the transaction so two admins demoting each other cannot both succeed.
      const isAdminNow = before.roleId === ADMIN_ROLE_ID && !before.disabled;
      const stopsBeingOne =
        (patch.roleId !== undefined && patch.roleId !== ADMIN_ROLE_ID) || patch.disabled === true;
      if (isAdminNow && stopsBeingOne && users.countActiveAdmins(id) === 0) {
        throw conflict("this is the last enabled admin; promote or enable another admin first");
      }
      if (credentials) users.setPassword(id, credentials);
      const after = users.update(id, {
        ...(patch.roleId === undefined ? {} : { roleId: patch.roleId }),
        ...(patch.disabled === undefined ? {} : { disabled: patch.disabled }),
      })!;
      return { before, after };
    });

    if (credentials || patch.disabled === true) {
      sessions.revokeAllFor(id);
      this.#d.onCredentialsRevoked?.(id);
    }
    audit.record(actor, "user.updated", id, {
      old: { roleId: before.roleId, disabled: before.disabled },
      new: {
        roleId: after.roleId,
        disabled: after.disabled,
        ...(credentials ? { passwordReset: true } : {}),
      },
    });
    return after;
  }

  async changeOwnPassword(
    actor: Actor,
    current: string,
    next: string,
    meta: RequestMeta,
  ): Promise<void> {
    const { users, passwords, limiter, sessions, audit } = this.#d;
    if (actor.kind !== "user")
      throw forbidden("only a logged-in user can change their own password");
    const user = users.get(actor.userId);
    const stored = user ? users.credentials(user.id) : undefined;
    if (!user || !stored) throw unauthorized();

    const verdict = limiter.check(meta.ip, user.email);
    if (!verdict.ok) throw rateLimited(verdict.retryAfterSec);
    if (!(await passwords.verify(current, stored))) {
      limiter.fail(meta.ip, user.email);
      throw new AppError("forbidden", "the current password is wrong");
    }
    users.setPassword(user.id, await passwords.hash(next));
    sessions.revokeAllFor(user.id, actor.sessionId);
    audit.record(actor, "auth.password.changed", user.id);
  }

  logout(actor: Actor): void {
    if (actor.kind !== "user") return;
    this.#d.sessions.revoke(actor.sessionId);
    this.#d.audit.record(actor, "auth.logout", actor.userId);
  }
}
