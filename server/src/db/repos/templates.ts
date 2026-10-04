import { must } from "@gangway/shared/must";
import type { Clearance, Template, Visibility } from "@gangway/shared/domain";
import { currentOrg, orgFilter } from "../../tenancy/scope.ts";
import type { Db, Params } from "../types.ts";
import { rowToTemplate, type TemplateRow } from "./mappers.ts";

export const DEFAULT_TEMPLATE_ID = "default";

export type CreateTemplate = {
  id: string;
  name: string;
  description?: string | undefined;
  visibility?: Visibility | undefined;
  ttl?: string | null | undefined;
  idleAfter?: string | undefined;
  clearance?: Clearance | undefined;
  hostId?: string | null | undefined;
};

export type TemplatePatch = {
  name?: string | undefined;
  description?: string | undefined;
  visibility?: Visibility | undefined;
  ttl?: string | null | undefined;
  idleAfter?: string | undefined;
  clearance?: Clearance | undefined;
  hostId?: string | null | undefined;
};

const COLUMNS: Record<keyof TemplatePatch, string> = {
  name: "name",
  description: "description",
  visibility: "visibility",
  ttl: "ttl",
  idleAfter: "idle_after",
  clearance: "clearance",
  hostId: "host_id",
};

export class TemplatesRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  // In the request's org; background work makes templates only in the home org.
  create(t: CreateTemplate): Template {
    const base = this.get(DEFAULT_TEMPLATE_ID);
    const now = this.#now();
    this.#db.run(
      `INSERT INTO templates (id, org_id, name, description, builtin, visibility, ttl, idle_after, clearance, host_id, created_at, updated_at)
       VALUES ($id, COALESCE($org, (SELECT id FROM orgs WHERE home = 1)), $name, $description, 0, $visibility, $ttl, $idleAfter, $clearance, $hostId, $now, $now)`,
      {
        id: t.id,
        org: currentOrg(),
        name: t.name,
        description: t.description ?? "",
        visibility: t.visibility ?? base?.visibility ?? "unlisted",
        ttl: t.ttl === undefined ? (base?.ttl ?? "7d") : t.ttl,
        idleAfter: t.idleAfter ?? base?.idleAfter ?? "30m",
        clearance: t.clearance ?? base?.clearance ?? "standard",
        hostId: t.hostId === undefined ? (base?.hostId ?? null) : t.hostId,
        now,
      },
    );
    return must(this.get(t.id), "the template just saved");
  }

  /** "default" names the org's own builtin default, whatever its id. */
  get(id: string): Template | undefined {
    if (id === DEFAULT_TEMPLATE_ID) {
      return this.#builtin();
    }
    const o = orgFilter();
    const r = this.#db.get(`SELECT * FROM templates WHERE id = $id AND ${o.sql}`, {
      id,
      ...o.params,
    }) as TemplateRow | undefined;
    return r ? rowToTemplate(r) : undefined;
  }

  default(): Template {
    const t = this.#builtin();
    if (!t) {
      throw new Error("the org has no default template");
    }
    return t;
  }

  // Background work, which has no org, takes the home org's.
  #builtin(): Template | undefined {
    const r = this.#db.get(
      `SELECT * FROM templates WHERE builtin = 1
         AND org_id = COALESCE($org, (SELECT id FROM orgs WHERE home = 1))`,
      { org: currentOrg() },
    ) as TemplateRow | undefined;
    return r ? rowToTemplate(r) : undefined;
  }

  /** Gives a new org a default template like the home org's, under its own id. */
  copyDefault(orgId: string, id: string, now: number): void {
    this.#db.run(
      `INSERT INTO templates (id, org_id, name, description, builtin, visibility, ttl, idle_after, clearance, host_id, created_at, updated_at)
       SELECT $id, $org, name, description, 1, visibility, ttl, idle_after, clearance, host_id, $now, $now
         FROM templates WHERE builtin = 1 AND org_id = (SELECT id FROM orgs WHERE home = 1)`,
      { id, org: orgId, now },
    );
  }

  list(): Template[] {
    return (
      this.#db.query(
        `SELECT * FROM templates WHERE ${orgFilter().sql} ORDER BY builtin DESC, name`,
        orgFilter().params,
      ) as TemplateRow[]
    ).map(rowToTemplate);
  }

  update(ref: string, patch: TemplatePatch): Template | undefined {
    const id = this.get(ref)?.id;
    if (id === undefined) {
      return undefined;
    }
    const sets: string[] = [];
    const params: Params = { id, now: this.#now() };
    for (const [k, v] of Object.entries(patch) as [keyof TemplatePatch, unknown][]) {
      if (v === undefined) {
        continue;
      }
      sets.push(`${COLUMNS[k]} = $${k}`);
      params[k] = v as string | null;
    }
    if (sets.length === 0) {
      return this.get(id);
    }
    this.#db.run(
      `UPDATE templates SET ${sets.join(", ")}, updated_at = $now WHERE id = $id`,
      params,
    );
    return this.get(id);
  }

  delete(id: string): boolean {
    if (id === DEFAULT_TEMPLATE_ID || this.get(id)?.builtin !== false) {
      return false;
    }
    return this.#db.run("DELETE FROM templates WHERE id = $id AND builtin = 0", { id }).changes > 0;
  }

  repoCount(id: string): number {
    return (
      (
        this.#db.get("SELECT COUNT(*) AS n FROM projects WHERE template_id = $id", {
          id,
        }) as { n: number } | undefined
      )?.n ?? 0
    );
  }
}
