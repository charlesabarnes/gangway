import type { Db } from "../types.ts";

export type LinkPurpose = "invite" | "reset";
export type UserLink = { userId: string; purpose: LinkPurpose; expiresAt: number };

type Row = { user_id: string; purpose: LinkPurpose; expires_at: number };

// The id is the sha256 of the emailed secret, so the table alone cannot be used to log in.
export class UserLinksRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  /** Replaces the user's earlier links: only the newest one works. */
  create(id: string, userId: string, purpose: LinkPurpose, ttlMs: number): void {
    const now = this.#now();
    this.#db.run("DELETE FROM user_links WHERE user_id = $userId", { userId });
    this.#db.run(
      `INSERT INTO user_links (id, user_id, purpose, created_at, expires_at)
       VALUES ($id, $userId, $purpose, $now, $expires)`,
      { id, userId, purpose, now, expires: now + ttlMs },
    );
  }

  /** A live link, or undefined for one that is unknown, used or expired. */
  get(id: string): UserLink | undefined {
    const r = this.#db.get<Row>(
      "SELECT user_id, purpose, expires_at FROM user_links WHERE id = $id AND expires_at > $now",
      { id, now: this.#now() },
    );
    return r ? { userId: r.user_id, purpose: r.purpose, expiresAt: r.expires_at } : undefined;
  }

  /** True for the one caller that used it; a second use of the same link gets false. */
  consume(id: string): boolean {
    return this.#db.run("DELETE FROM user_links WHERE id = $id", { id }).changes > 0;
  }

  deleteForUser(userId: string): void {
    this.#db.run("DELETE FROM user_links WHERE user_id = $userId", { userId });
  }

  purge(): number {
    return this.#db.run("DELETE FROM user_links WHERE expires_at <= $now", { now: this.#now() })
      .changes;
  }
}
