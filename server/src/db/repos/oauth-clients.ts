import type { Db } from "../types.ts";

export type RegisteredClient = {
  id: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
};

type Row = { id: string; client_name: string; redirect_uris: string; created_at: number };

export class OAuthClientsRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  create(c: RegisteredClient): void {
    this.#db.run(
      `INSERT INTO oauth_clients (id, client_name, redirect_uris, created_at)
       VALUES ($id, $name, $uris, $at)`,
      { id: c.id, name: c.clientName, uris: JSON.stringify(c.redirectUris), at: c.createdAt },
    );
  }

  get(id: string): RegisteredClient | undefined {
    const r = this.#db.get<Row>(
      "SELECT id, client_name, redirect_uris, created_at FROM oauth_clients WHERE id = $id",
      { id },
    );
    return r
      ? {
          id: r.id,
          clientName: r.client_name,
          redirectUris: JSON.parse(r.redirect_uris) as string[],
          createdAt: r.created_at,
        }
      : undefined;
  }

  /** Marks a client as having started an authorization, which keeps it past the purge. */
  touch(id: string, now: number): void {
    this.#db.run("UPDATE oauth_clients SET last_used_at = $now WHERE id = $id", { id, now });
  }

  count(): number {
    return this.#db.get<{ n: number }>("SELECT count(*) AS n FROM oauth_clients")!.n;
  }

  /** Drops registrations made before `before` that never started an authorization. */
  purgeUnused(before: number): number {
    return this.#db.run(
      `DELETE FROM oauth_clients WHERE last_used_at IS NULL AND created_at < $before
         AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.id)`,
      { before },
    ).changes;
  }
}
