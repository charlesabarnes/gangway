import type { Clearance, Template, Visibility } from "@gangway/shared/domain";
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

/** Absent and undefined both mean "leave it": zod's optional output is passed straight through. */
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

/** Named preview policies. `default` is seeded by migration 0007 and never deleted. */
export class TemplatesRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  /** A new template starts from the built-in one's values for anything left unsaid. */
  create(t: CreateTemplate): Template {
    const base = this.get(DEFAULT_TEMPLATE_ID);
    const now = this.#now();
    this.#db.run(
      `INSERT INTO templates (id, name, description, builtin, visibility, ttl, idle_after, clearance, host_id, created_at, updated_at)
       VALUES ($id, $name, $description, 0, $visibility, $ttl, $idleAfter, $clearance, $hostId, $now, $now)`,
      {
        id: t.id,
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
    return this.get(t.id)!;
  }

  get(id: string): Template | undefined {
    const r = this.#db.get<TemplateRow>("SELECT * FROM templates WHERE id = $id", { id });
    return r ? rowToTemplate(r) : undefined;
  }

  /** The built-in one. Present in every migrated database; the fallback for everything. */
  default(): Template {
    const t = this.get(DEFAULT_TEMPLATE_ID);
    if (!t) throw new Error("the default template is missing; migration 0007 did not run");
    return t;
  }

  list(): Template[] {
    return this.#db
      .query<TemplateRow>("SELECT * FROM templates ORDER BY builtin DESC, name")
      .map(rowToTemplate);
  }

  update(id: string, patch: TemplatePatch): Template | undefined {
    const sets: string[] = [];
    const params: Params = { id, now: this.#now() };
    for (const [k, v] of Object.entries(patch) as [keyof TemplatePatch, unknown][]) {
      if (v === undefined) continue;
      sets.push(`${COLUMNS[k]} = $${k}`);
      params[k] = v as string | null;
    }
    if (sets.length === 0) return this.get(id);
    this.#db.run(
      `UPDATE templates SET ${sets.join(", ")}, updated_at = $now WHERE id = $id`,
      params,
    );
    return this.get(id);
  }

  /** Repositories on this template fall back to the trigger default (ON DELETE SET NULL). */
  delete(id: string): boolean {
    if (id === DEFAULT_TEMPLATE_ID) return false;
    return this.#db.run("DELETE FROM templates WHERE id = $id AND builtin = 0", { id }).changes > 0;
  }

  /** How many projects name this template -- said before a delete, not after. */
  repoCount(id: string): number {
    return (
      this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM projects WHERE template_id = $id", {
        id,
      })?.n ?? 0
    );
  }
}
