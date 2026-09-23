import type { OAuthGrant, User } from "../../../../shared/src/domain.ts";
import type { Scope } from "../../../../shared/src/permissions.ts";
import type { Db } from "../types.ts";
import { rowToUser, type UserRow } from "./mappers.ts";

type GrantRow = {
  id: string; user_id: string; client_id: string; client_name: string; redirect_uri: string; scopes: string;
  resource: string; access_expires_at: number; refresh_expires_at: number; absolute_expires_at: number;
  created_at: number; last_used_at: number | null; revoked_at: number | null;
};
const COLUMNS = "id, user_id, client_id, client_name, redirect_uri, scopes, resource, access_expires_at, refresh_expires_at, absolute_expires_at, created_at, last_used_at, revoked_at";
const cols = (alias: string) => COLUMNS.split(", ").map((c) => `${alias}.${c}`).join(", ");

const toGrant = (r: GrantRow): OAuthGrant => ({
  id: r.id, userId: r.user_id, clientId: r.client_id, clientName: r.client_name, redirectUri: r.redirect_uri,
  scopes: JSON.parse(r.scopes) as Scope[], createdAt: new Date(r.created_at),
  lastUsedAt: r.last_used_at === null ? null : new Date(r.last_used_at),
  expiresAt: new Date(r.absolute_expires_at), revokedAt: r.revoked_at === null ? null : new Date(r.revoked_at),
});

/** What the token endpoint and the verifier need beyond the wire shape. */
export type GrantRecord = { grant: OAuthGrant; resource: string; accessExpiresAt: number; refreshExpiresAt: number; owner: User };

export type CreateGrant = {
  id: string; userId: string; clientId: string; clientName: string; redirectUri: string; scopes: readonly Scope[]; resource: string;
  accessHash: string; accessExpiresAt: number; refreshHash: string; refreshExpiresAt: number; absoluteExpiresAt: number;
};

type Joined = GrantRow & { u_id: string; u_email: string; u_role_id: string; u_disabled: number; u_created_at: number };
const JOIN = `SELECT ${cols("g")}, u.id AS u_id, u.email AS u_email, u.role_id AS u_role_id, u.disabled AS u_disabled, u.created_at AS u_created_at
                FROM oauth_grants g JOIN users u ON u.id = g.user_id`;

const toRecord = (r: Joined): GrantRecord => {
  const owner: UserRow = { id: r.u_id, email: r.u_email, role_id: r.u_role_id, disabled: r.u_disabled, created_at: r.u_created_at };
  return { grant: toGrant(r), resource: r.resource, accessExpiresAt: r.access_expires_at, refreshExpiresAt: r.refresh_expires_at, owner: rowToUser(owner) };
};

/** ADR-0020. Tokens are stored as sha256 hashes and never selected into a domain object. */
export class OAuthGrantsRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  create(g: CreateGrant): OAuthGrant {
    this.#db.run(
      `INSERT INTO oauth_grants (id, user_id, client_id, client_name, redirect_uri, scopes, resource, access_hash, access_expires_at,
                                 refresh_hash, refresh_expires_at, absolute_expires_at, created_at)
       VALUES ($id, $user, $client, $name, $redirect, $scopes, $resource, $ah, $aexp, $rh, $rexp, $abs, $now)`,
      { id: g.id, user: g.userId, client: g.clientId, name: g.clientName, redirect: g.redirectUri, scopes: JSON.stringify(g.scopes), resource: g.resource,
        ah: g.accessHash, aexp: g.accessExpiresAt, rh: g.refreshHash, rexp: g.refreshExpiresAt, abs: g.absoluteExpiresAt, now: this.#now() },
    );
    return this.get(g.id)!;
  }

  get(id: string): OAuthGrant | undefined {
    const r = this.#db.get<GrantRow>(`SELECT ${COLUMNS} FROM oauth_grants WHERE id = $id`, { id });
    return r ? toGrant(r) : undefined;
  }

  /** The verifier's one read: a live access token of a live grant whose owner is enabled. */
  findByAccess(hash: string, now: number = this.#now()): GrantRecord | undefined {
    const r = this.#db.get<Joined>(
      `${JOIN} WHERE g.access_hash = $hash AND g.revoked_at IS NULL AND g.access_expires_at > $now AND u.disabled = 0`,
      { hash, now },
    );
    return r ? toRecord(r) : undefined;
  }

  /** The refresh grant's read. Expiry and the owner are judged by the caller, which must say why. */
  findByRefresh(hash: string): GrantRecord | undefined {
    const r = this.#db.get<Joined>(`${JOIN} WHERE g.refresh_hash = $hash AND g.revoked_at IS NULL`, { hash });
    return r ? toRecord(r) : undefined;
  }

  /** A refresh token that was already rotated away: replay. */
  findByPreviousRefresh(hash: string): OAuthGrant | undefined {
    const r = this.#db.get<GrantRow>(`SELECT ${COLUMNS} FROM oauth_grants WHERE prev_refresh_hash = $hash`, { hash });
    return r ? toGrant(r) : undefined;
  }

  /**
   * Rotation, conditional on the refresh token still being the current one: of two
   * concurrent refreshes with one token, exactly one wins.
   */
  rotate(id: string, from: string, next: { accessHash: string; accessExpiresAt: number; refreshHash: string; refreshExpiresAt: number }): boolean {
    return this.#db.run(
      `UPDATE oauth_grants SET access_hash = $ah, access_expires_at = $aexp, prev_refresh_hash = refresh_hash, refresh_hash = $rh,
                               refresh_expires_at = $rexp, last_used_at = $now
        WHERE id = $id AND refresh_hash = $from AND revoked_at IS NULL`,
      { id, from, ah: next.accessHash, aexp: next.accessExpiresAt, rh: next.refreshHash, rexp: next.refreshExpiresAt, now: this.#now() },
    ).changes > 0;
  }

  touch(id: string, staleBefore: number, now: number = this.#now()): void {
    this.#db.run("UPDATE oauth_grants SET last_used_at = $now WHERE id = $id AND (last_used_at IS NULL OR last_used_at < $stale)", { id, now, stale: staleBefore });
  }

  listForUser(userId: string): OAuthGrant[] {
    return this.#db.query<GrantRow>(`SELECT ${COLUMNS} FROM oauth_grants WHERE user_id = $u AND revoked_at IS NULL ORDER BY created_at DESC, id`, { u: userId }).map(toGrant);
  }

  listAll(): OAuthGrant[] {
    return this.#db.query<GrantRow>(`SELECT ${COLUMNS} FROM oauth_grants WHERE revoked_at IS NULL ORDER BY created_at DESC, id`).map(toGrant);
  }

  revoke(id: string, now: number = this.#now()): boolean {
    return this.#db.run("UPDATE oauth_grants SET revoked_at = $now WHERE id = $id AND revoked_at IS NULL", { id, now }).changes > 0;
  }

  revokeAllFor(userId: string, now: number = this.#now()): number {
    return this.#db.run("UPDATE oauth_grants SET revoked_at = $now WHERE user_id = $u AND revoked_at IS NULL", { u: userId, now }).changes;
  }

  /** Housekeeping: grants past their absolute end, or revoked, a while ago. */
  purge(before: number): number {
    return this.#db.run("DELETE FROM oauth_grants WHERE absolute_expires_at < $b OR (revoked_at IS NOT NULL AND revoked_at < $b)", { b: before }).changes;
  }
}
