import type { Db } from "../types.ts";

/** Which account a provider's (issuer, subject) signs in to. */
export class UserIdentitiesRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  userFor(issuer: string, subject: string): string | undefined {
    const r = this.#db.get(
      "SELECT user_id FROM user_identities WHERE issuer = $issuer AND subject = $subject",
      { issuer, subject },
    ) as { user_id: string } | undefined;
    return r?.user_id;
  }

  link(issuer: string, subject: string, userId: string): void {
    const now = this.#now();
    this.#db.run(
      `INSERT INTO user_identities (issuer, subject, user_id, created_at, last_used_at)
       VALUES ($issuer, $subject, $userId, $now, $now)
       ON CONFLICT (issuer, subject) DO UPDATE SET last_used_at = $now`,
      { issuer, subject, userId, now },
    );
  }

  touch(issuer: string, subject: string): void {
    this.#db.run(
      "UPDATE user_identities SET last_used_at = $now WHERE issuer = $issuer AND subject = $subject",
      { issuer, subject, now: this.#now() },
    );
  }
}
