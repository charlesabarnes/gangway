import type { ApiToken, User } from "../../../../shared/src/domain.ts";
import type { Scope } from "../../../../shared/src/permissions.ts";
import type { Db } from "../types.ts";
import { TOKEN_COLUMNS, rowToToken, rowToUser, type TokenRow, type UserRow } from "./mappers.ts";

export type CreateToken = {
  id: string;
  name: string;
  prefix: string;
  tokenHash: string;
  scopes: readonly Scope[];
  userId: string | null;
  expiresAt: number | null;
};

/** §8.2 API tokens. Only the sha256 is stored; `token_hash` is never selected into a domain object. */
export class TokensRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  create(t: CreateToken): ApiToken {
    this.#db.run(
      `INSERT INTO api_tokens (id, name, prefix, token_hash, scopes, user_id, expires_at, created_at)
       VALUES ($id, $name, $prefix, $hash, $scopes, $user, $exp, $now)`,
      {
        id: t.id,
        name: t.name,
        prefix: t.prefix,
        hash: t.tokenHash,
        scopes: JSON.stringify(t.scopes),
        user: t.userId,
        exp: t.expiresAt,
        now: this.#now(),
      },
    );
    return this.get(t.id)!;
  }

  get(id: string): ApiToken | undefined {
    const r = this.#db.get<TokenRow>(`SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE id = $id`, {
      id,
    });
    return r ? rowToToken(r) : undefined;
  }

  /**
   * The verifier's one read. Revoked, expired, or owned by a disabled account: all "no".
   * `owner` is null for an ownerless token, which is NOT the same as a missing owner --
   * the FK cascades, so a token never outlives its account.
   */
  findActiveByHash(
    tokenHash: string,
    now: number = this.#now(),
  ): { token: ApiToken; owner: User | null } | undefined {
    const r = this.#db.get<
      TokenRow & {
        u_id: string | null;
        u_email: string | null;
        u_role_id: string | null;
        u_disabled: number | null;
        u_created_at: number | null;
      }
    >(
      `SELECT ${TOKEN_COLUMNS.split(", ")
        .map((c) => `t.${c}`)
        .join(", ")},
              u.id AS u_id, u.email AS u_email, u.role_id AS u_role_id, u.disabled AS u_disabled, u.created_at AS u_created_at
         FROM api_tokens t LEFT JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $hash AND t.revoked_at IS NULL
          AND (t.expires_at IS NULL OR t.expires_at > $now)
          AND (t.user_id IS NULL OR u.disabled = 0)`,
      { hash: tokenHash, now },
    );
    if (!r) return undefined;
    const owner: UserRow | null =
      r.u_id === null
        ? null
        : {
            id: r.u_id,
            email: r.u_email!,
            role_id: r.u_role_id!,
            disabled: r.u_disabled!,
            created_at: r.u_created_at!,
          };
    return { token: rowToToken(r), owner: owner ? rowToUser(owner) : null };
  }

  /** "Last used", throttled like a session's: a CI job hammering the API writes once a minute. */
  touch(id: string, staleBefore: number, now: number = this.#now()): boolean {
    return (
      this.#db.run(
        "UPDATE api_tokens SET last_used_at = $now WHERE id = $id AND (last_used_at IS NULL OR last_used_at < $stale)",
        { id, now, stale: staleBefore },
      ).changes > 0
    );
  }

  listForUser(userId: string): ApiToken[] {
    return this.#db
      .query<TokenRow>(
        `SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE user_id = $u ORDER BY created_at DESC, id`,
        { u: userId },
      )
      .map(rowToToken);
  }

  listAll(): ApiToken[] {
    return this.#db
      .query<TokenRow>(`SELECT ${TOKEN_COLUMNS} FROM api_tokens ORDER BY created_at DESC, id`)
      .map(rowToToken);
  }

  /** Revoked, not deleted: "which token did that" must still have an answer in the audit log. */
  revoke(id: string, now: number = this.#now()): boolean {
    return (
      this.#db.run(
        "UPDATE api_tokens SET revoked_at = $now WHERE id = $id AND revoked_at IS NULL",
        { id, now },
      ).changes > 0
    );
  }

  /**
   * §10.5.1 lockout guard: is there a live `admin`-scoped token? Asked before the UI may be
   * switched off. An owned token counts only while its owner is an enabled admin -- a token
   * whose scopes are clamped to nothing is not a way back in.
   */
  hasActiveAdmin(now: number = this.#now()): boolean {
    return (
      this.#db.get<{ n: number }>(
        `SELECT COUNT(*) AS n
         FROM api_tokens t LEFT JOIN users u ON u.id = t.user_id, json_each(t.scopes) s
        WHERE s.value = 'admin' AND t.revoked_at IS NULL
          AND (t.expires_at IS NULL OR t.expires_at > $now)
          AND (t.user_id IS NULL OR (u.disabled = 0 AND u.role_id = 'admin'))`,
        { now },
      )!.n > 0
    );
  }
}
