import {
  OrgLimitsSchema,
  type Org,
  type OrgLimits,
  type OrgSeats,
  type OrgState,
} from "@gangway/shared/orgs-api";
import type { Db } from "../types.ts";

export const HOME_ORG_ID = "00000000000000000000000000";

type OrgRow = {
  id: string;
  slug: string;
  name: string;
  home: number;
  state: OrgState;
  created_at: number;
  updated_at: number;
};

const toOrg = (r: OrgRow): Org => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  home: r.home === 1,
  state: r.state,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export type OrgLimitsRecord = { planLabel: string | null; limits: OrgLimits; updatedAt: number };

export class OrgsRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  get(id: string): Org | undefined {
    const r = this.#db.get("SELECT * FROM orgs WHERE id = $id", { id }) as OrgRow | undefined;
    return r ? toOrg(r) : undefined;
  }

  home(): Org {
    const r = this.#db.get("SELECT * FROM orgs WHERE home = 1") as OrgRow | undefined;
    if (!r) {
      throw new Error("the database has no home org");
    }
    return toOrg(r);
  }

  create(o: { id: string; slug: string; name: string }): Org {
    const now = this.#now();
    this.#db.run(
      "INSERT INTO orgs (id, slug, name, created_at, updated_at) VALUES ($id, $slug, $name, $now, $now)",
      { ...o, now },
    );
    return toOrg(this.#db.get("SELECT * FROM orgs WHERE id = $id", { id: o.id }) as OrgRow);
  }

  bySlug(slug: string): Org | undefined {
    const r = this.#db.get("SELECT * FROM orgs WHERE slug = $slug", { slug }) as OrgRow | undefined;
    return r ? toOrg(r) : undefined;
  }

  list(): Org[] {
    return (this.#db.query("SELECT * FROM orgs ORDER BY created_at, id") as OrgRow[]).map(toOrg);
  }

  setState(id: string, state: OrgState): void {
    this.#db.run(
      "UPDATE orgs SET state = $state, updated_at = $now WHERE id = $id AND state <> $state",
      { id, state, now: this.#now() },
    );
  }

  suspendedIds(): string[] {
    return (
      this.#db.query("SELECT id FROM orgs WHERE state = 'suspended'") as { id: string }[]
    ).map((r) => r.id);
  }

  /** Orgs changed after `since` (all of them without it), each with how many people it has. */
  seats(since?: number): OrgSeats[] {
    const rows = this.#db.query(
      `SELECT o.*, (SELECT count(*) FROM memberships m WHERE m.org_id = o.id) AS members
         FROM orgs o WHERE $since IS NULL OR o.updated_at > $since
        ORDER BY o.updated_at, o.id`,
      { since: since ?? null },
    ) as (OrgRow & { members: number })[];
    return rows.map((r) => ({ ...toOrg(r), members: r.members }));
  }

  limitsOf(orgId: string): OrgLimitsRecord | undefined {
    const r = this.#db.get(
      "SELECT plan_label, limits_json, updated_at FROM org_limits WHERE org_id = $orgId",
      { orgId },
    ) as { plan_label: string | null; limits_json: string; updated_at: number } | undefined;
    if (!r) {
      return undefined;
    }
    return {
      planLabel: r.plan_label,
      limits: OrgLimitsSchema.parse(JSON.parse(r.limits_json)),
      updatedAt: r.updated_at,
    };
  }

  /** Replaces the whole set, so a key left out stops limiting. */
  setLimits(orgId: string, planLabel: string | null, limits: OrgLimits, by: string): void {
    this.#db.run(
      `INSERT INTO org_limits (org_id, plan_label, limits_json, updated_by, updated_at)
       VALUES ($orgId, $planLabel, $json, $by, $now)
       ON CONFLICT (org_id) DO UPDATE SET plan_label = $planLabel, limits_json = $json,
         updated_by = $by, updated_at = $now`,
      {
        orgId,
        planLabel,
        json: JSON.stringify(OrgLimitsSchema.parse(limits)),
        by,
        now: this.#now(),
      },
    );
  }
}
