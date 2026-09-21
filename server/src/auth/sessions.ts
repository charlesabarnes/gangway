/**
 * §8.1 sessions. The cookie carries 32 random bytes; the table is keyed on their sha256.
 * A stolen database -- or a backup of one -- therefore holds nothing that can be presented.
 *
 * `resolve` runs on every cookie-authenticated request and builds the actor FRESH: the
 * account and its role are read now, and the role's permissions come from the in-memory
 * matrix. Disabling a user, changing their role, or editing what a role may do all take
 * effect on the next request. Nothing about authority is cached in the session.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Session, User } from "../../../shared/src/domain.ts";
import type { SessionsRepo } from "../db/repos/sessions.ts";
import type { Actor } from "./actor.ts";
import type { RolePermissions } from "./roles.ts";

const MIN = 60_000, DAY = 86_400_000;

export type SessionTimings = {
  /** Unused this long, a session is over. */
  idleMs: number;
  /** However busy, a session ends this long after login. */
  absoluteMs: number;
  /** The sliding-expiry write happens at most this often per session. */
  touchEveryMs: number;
};

export const DEFAULT_SESSION_TIMINGS: SessionTimings = { idleMs: 7 * DAY, absoluteMs: 30 * DAY, touchEveryMs: 5 * MIN };

const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const idFor = (secret: string) => createHash("sha256").update(secret).digest("hex");

export class Sessions {
  readonly #repo: SessionsRepo;
  readonly #roles: RolePermissions;
  readonly #now: () => number;
  readonly timings: SessionTimings;

  constructor(repo: SessionsRepo, roles: RolePermissions, now: () => number = Date.now, timings: Partial<SessionTimings> = {}) {
    this.#repo = repo;
    this.#roles = roles;
    this.#now = now;
    this.timings = { ...DEFAULT_SESSION_TIMINGS, ...timings };
  }

  /** `secret` goes into the cookie and is never seen again; only its hash is kept. */
  issue(userId: string, meta: { ip: string | null; userAgent: string | null }): { secret: string; session: Session } {
    const secret = randomBytes(32).toString("base64url");
    const session = this.#repo.create({
      id: idFor(secret), userId, expiresAt: this.#now() + Math.min(this.timings.idleMs, this.timings.absoluteMs),
      ip: meta.ip, userAgent: meta.userAgent?.slice(0, 512) ?? null,
    });
    return { secret, session };
  }

  resolve(secret: string): { actor: Actor; user: User; session: Session } | null {
    // Shape first: a cookie is attacker-controlled, and this saves hashing megabytes of junk.
    if (!SECRET_RE.test(secret)) return null;
    const now = this.#now();
    const id = idFor(secret);
    const found = this.#repo.findActive(id, now);
    if (!found) return null;
    this.#repo.touch(id, { staleBefore: now - this.timings.touchEveryMs, idleMs: this.timings.idleMs, absoluteMs: this.timings.absoluteMs }, now);
    const { user, session } = found;
    return { actor: { kind: "user", userId: user.id, roleId: user.roleId, permissions: this.#roles.for(user.roleId), sessionId: id }, user, session };
  }

  revoke(sessionId: string): boolean {
    return this.#repo.delete(sessionId);
  }

  revokeAllFor(userId: string, exceptSessionId?: string): number {
    return this.#repo.deleteForUser(userId, exceptSessionId);
  }

  /** The scheduler's hourly job. Expired rows are already refused; this only reclaims them. */
  purge(): number {
    return this.#repo.purgeExpired(this.#now());
  }
}
