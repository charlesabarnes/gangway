import type { Session, User } from "../../../../shared/src/domain.ts";
import type { Db } from "../types.ts";
import { rowToSession, rowToUser, type SessionRow, type UserRow } from "./mappers.ts";

export type CreateSession = { id: string; userId: string; expiresAt: number; ip: string | null; userAgent: string | null };

/**
 * §8.1 sessions. `id` is the sha256 of the cookie's secret, so this table -- and every
 * backup of it -- holds nothing a thief could present.
 */
export class SessionsRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  create(s: CreateSession): Session {
    const now = this.#now();
    this.#db.run(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
       VALUES ($id, $user, $now, $exp, $now, $ip, $ua)`,
      { id: s.id, user: s.userId, now, exp: s.expiresAt, ip: s.ip, ua: s.userAgent },
    );
    return rowToSession(this.#db.get<SessionRow>("SELECT * FROM sessions WHERE id = $id", { id: s.id })!);
  }

  /**
   * The session AND its account in one read, because this runs on every cookie request:
   * an expired session, a disabled account and an unknown id are all simply "no".
   */
  findActive(id: string, now: number = this.#now()): { session: Session; user: User } | undefined {
    const r = this.#db.get<SessionRow & { u_id: string; u_email: string; u_role_id: string; u_disabled: number; u_created_at: number }>(
      `SELECT s.*, u.id AS u_id, u.email AS u_email, u.role_id AS u_role_id, u.disabled AS u_disabled, u.created_at AS u_created_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $id AND s.expires_at > $now AND u.disabled = 0`,
      { id, now },
    );
    if (!r) return undefined;
    const user: UserRow = { id: r.u_id, email: r.u_email, role_id: r.u_role_id, disabled: r.u_disabled, created_at: r.u_created_at };
    return { session: rowToSession(r), user: rowToUser(user) };
  }

  /**
   * Sliding expiry, throttled: ONE conditional UPDATE that does nothing unless the session
   * was last seen before `staleBefore`. A busy tab costs a write every few minutes, not
   * one per request. The new expiry never passes the absolute cap.
   */
  touch(id: string, o: { staleBefore: number; idleMs: number; absoluteMs: number }, now: number = this.#now()): boolean {
    return this.#db.run(
      `UPDATE sessions
          SET last_seen_at = $now, expires_at = MIN($now + $idle, created_at + $abs)
        WHERE id = $id AND (last_seen_at IS NULL OR last_seen_at < $stale)`,
      { id, now, idle: o.idleMs, abs: o.absoluteMs, stale: o.staleBefore },
    ).changes > 0;
  }

  delete(id: string): boolean {
    return this.#db.run("DELETE FROM sessions WHERE id = $id", { id }).changes > 0;
  }

  /** A password change ends every OTHER session; a reset or a disable ends all of them. */
  deleteForUser(userId: string, exceptId?: string): number {
    return this.#db.run("DELETE FROM sessions WHERE user_id = $u AND id != $except", { u: userId, except: exceptId ?? "" }).changes;
  }

  purgeExpired(now: number = this.#now()): number {
    return this.#db.run("DELETE FROM sessions WHERE expires_at <= $now", { now }).changes;
  }
}
