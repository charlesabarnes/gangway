import { must } from "@gangway/shared/must";
import type { ApiToken, User } from "@gangway/shared/domain";
import type { Scope, SecretTargets } from "@gangway/shared/permissions";
import type { Db } from "../types.ts";
import { TOKEN_COLUMNS, rowToToken, type TokenRow } from "./mappers.ts";
import { rowToUser, type UserRow } from "./users.ts";

export type CreateToken = {
  id: string;
  name: string;
  prefix: string;
  tokenHash: string;
  scopes: readonly Scope[];
  secretTargets?: SecretTargets | null | undefined;
  userId: string | null;
  expiresAt: number | null;
};

export class TokensRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  create(t: CreateToken): ApiToken {
    this.#db.run(
      `INSERT INTO api_tokens (id, name, prefix, token_hash, scopes, secret_targets, user_id, expires_at, created_at)
       VALUES ($id, $name, $prefix, $hash, $scopes, $targets, $user, $exp, $now)`,
      {
        id: t.id,
        name: t.name,
        prefix: t.prefix,
        hash: t.tokenHash,
        scopes: JSON.stringify(t.scopes),
        targets: t.secretTargets ? JSON.stringify(t.secretTargets) : null,
        user: t.userId,
        exp: t.expiresAt,
        now: this.#now(),
      },
    );
    return must(this.get(t.id), "the token just saved");
  }

  get(id: string): ApiToken | undefined {
    const r = this.#db.get(`SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE id = $id`, {
      id,
    }) as TokenRow | undefined;
    return r ? rowToToken(r) : undefined;
  }

  findActiveByHash(
    tokenHash: string,
    now: number = this.#now(),
  ): { token: ApiToken; owner: User | null } | undefined {
    const r = this.#db.get(
      `SELECT ${TOKEN_COLUMNS.split(", ")
        .map((c) => `t.${c}`)
        .join(", ")},
              u.id AS u_id, u.email AS u_email, u.role_id AS u_role_id, u.disabled AS u_disabled, u.invited AS u_invited, u.created_at AS u_created_at
         FROM api_tokens t LEFT JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $hash AND t.revoked_at IS NULL
          AND (t.expires_at IS NULL OR t.expires_at > $now)
          AND (t.user_id IS NULL OR u.disabled = 0)`,
      { hash: tokenHash, now },
    ) as
      | (TokenRow & {
          u_id: string | null;
          u_email: string | null;
          u_role_id: string | null;
          u_disabled: number | null;
          u_invited: number | null;
          u_created_at: number | null;
        })
      | undefined;
    if (!r) {
      return undefined;
    }
    const owner: UserRow | null =
      r.u_id === null
        ? null
        : {
            id: r.u_id,
            email: must(r.u_email, "the token owner's email"),
            role_id: must(r.u_role_id, "the token owner's role"),
            disabled: must(r.u_disabled, "the token owner's disabled flag"),
            invited: must(r.u_invited, "the token owner's invited flag"),
            created_at: must(r.u_created_at, "the token owner's creation time"),
          };
    return { token: rowToToken(r), owner: owner ? rowToUser(owner) : null };
  }

  touch(id: string, staleBefore: number, now: number = this.#now()): boolean {
    return (
      this.#db.run(
        "UPDATE api_tokens SET last_used_at = $now WHERE id = $id AND (last_used_at IS NULL OR last_used_at < $stale)",
        { id, now, stale: staleBefore },
      ).changes > 0
    );
  }

  listForUser(userId: string): ApiToken[] {
    return (
      this.#db.query(
        `SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE user_id = $u ORDER BY created_at DESC, id`,
        { u: userId },
      ) as TokenRow[]
    ).map(rowToToken);
  }

  listAll(): ApiToken[] {
    return (
      this.#db.query(
        `SELECT ${TOKEN_COLUMNS} FROM api_tokens ORDER BY created_at DESC, id`,
      ) as TokenRow[]
    ).map(rowToToken);
  }

  revoke(id: string, now: number = this.#now()): boolean {
    return (
      this.#db.run(
        "UPDATE api_tokens SET revoked_at = $now WHERE id = $id AND revoked_at IS NULL",
        { id, now },
      ).changes > 0
    );
  }

  hasActiveAdmin(now: number = this.#now()): boolean {
    const row = this.#db.get(
      `SELECT COUNT(*) AS n
       FROM api_tokens t LEFT JOIN users u ON u.id = t.user_id, json_each(t.scopes) s
      WHERE s.value = 'admin' AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > $now)
        AND (t.user_id IS NULL OR (u.disabled = 0 AND u.role_id = 'admin'))`,
      { now },
    ) as { n: number } | undefined;
    return must(row, "a count row").n > 0;
  }
}
