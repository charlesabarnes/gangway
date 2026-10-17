import type { Takedown } from "@gangway/shared/orgs-api";
import type { Db } from "../types.ts";

type TakedownRow = {
  hostname: string;
  preview_id: string;
  org_id: string;
  reason: string;
  created_by: string;
  created_at: number;
};

const toTakedown = (r: TakedownRow): Takedown => ({
  hostname: r.hostname,
  previewId: r.preview_id,
  orgId: r.org_id,
  reason: r.reason,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

/** Hostnames the operator took down, across every org: never a tenant's repo. */
export class TakedownsRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  list(): Takedown[] {
    return (
      this.#db.query("SELECT * FROM takedowns ORDER BY created_at, hostname") as TakedownRow[]
    ).map(toTakedown);
  }

  get(hostname: string): Takedown | undefined {
    const r = this.#db.get("SELECT * FROM takedowns WHERE hostname = $hostname", { hostname }) as
      TakedownRow | undefined;
    return r ? toTakedown(r) : undefined;
  }

  /** Takes every hostname down at once; one already down keeps its first reason. */
  add(
    hostnames: string[],
    t: { previewId: string; orgId: string; reason: string; createdBy: string },
  ): Takedown[] {
    const now = this.#now();
    this.#db.transaction(() => {
      for (const hostname of hostnames) {
        this.#db.run(
          `INSERT INTO takedowns (hostname, preview_id, org_id, reason, created_by, created_at)
           VALUES ($hostname, $previewId, $orgId, $reason, $createdBy, $now)
           ON CONFLICT (hostname) DO NOTHING`,
          { hostname, ...t, now },
        );
      }
    });
    return hostnames.flatMap((h) => this.get(h) ?? []);
  }

  remove(hostname: string): boolean {
    return (
      this.#db.run("DELETE FROM takedowns WHERE hostname = $hostname", { hostname }).changes > 0
    );
  }
}
