import { must } from "@gangway/shared/must";
import type {
  Clearance,
  ForgeId,
  ForkPolicy,
  PrTrigger,
  Project,
  RepoProject,
  Visibility,
} from "@gangway/shared/domain";
import type { Db, Params } from "../types.ts";
import { num, rowToProject, type ProjectRow } from "./mappers.ts";

export type CreateProject = {
  id: string;
  name: string;
  slug: string;
  forge?: ForgeId | null | undefined;
  fullName?: string | null | undefined;
  installationId?: string | undefined;
  prTrigger?: PrTrigger | undefined;
  enabled?: boolean | undefined;
  disabledReason?: string | null | undefined;
  templateId?: string | null | undefined;
};

export type ProjectPatch = {
  name?: string | undefined;
  slug?: string | undefined;
  enabled?: boolean | undefined;
  disabledReason?: string | null | undefined;
  installationId?: string | undefined;
  prTrigger?: PrTrigger | undefined;
  templateId?: string | null | undefined;
  visibility?: Visibility | null | undefined;
  ttl?: string | null | undefined;
  forks?: ForkPolicy | undefined;
  drafts?: boolean | undefined;
  prClearance?: Clearance | null | undefined;
  forkClearance?: Clearance | undefined;
  watermark?: "on" | "off" | null | undefined;
  domain?: string | null | undefined;
  productionPreviewId?: string | null | undefined;
};

const COLUMNS: Record<keyof ProjectPatch, string> = {
  name: "name",
  slug: "slug",
  enabled: "enabled",
  disabledReason: "disabled_reason",
  installationId: "installation_id",
  prTrigger: "pr_trigger",
  templateId: "template_id",
  visibility: "visibility",
  ttl: "ttl",
  forks: "forks",
  drafts: "drafts",
  prClearance: "pr_clearance",
  forkClearance: "fork_clearance",
  watermark: "watermark",
  domain: "domain",
  productionPreviewId: "production_preview_id",
};

export class ProjectsRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  create(p: CreateProject): Project {
    const now = this.#now();
    this.#db.run(
      `INSERT INTO projects (id, name, slug, forge, full_name, installation_id, pr_trigger, enabled, disabled_reason, template_id, created_at, updated_at)
       VALUES ($id, $name, $slug, $forge, $fullName, $installationId, $prTrigger, $enabled, $reason, $templateId, $now, $now)`,
      {
        id: p.id,
        name: p.name,
        slug: p.slug,
        forge: p.forge ?? null,
        fullName: p.fullName ?? null,
        installationId: p.installationId ?? "",
        prTrigger: p.prTrigger ?? "workflow",
        enabled: num(p.enabled ?? true),
        reason: p.disabledReason ?? null,
        templateId: p.templateId ?? null,
        now,
      },
    );
    return must(this.get(p.id), "the project just saved");
  }

  get(id: string): Project | undefined {
    const r = this.#db.get("SELECT * FROM projects WHERE id = $id", { id }) as
      ProjectRow | undefined;
    return r ? rowToProject(r) : undefined;
  }

  find(ref: string): Project | undefined {
    return this.get(ref) ?? this.getBySlug(ref);
  }

  getByFullName(forge: ForgeId, fullName: string): RepoProject | undefined {
    // NOCASE because GitHub repository names are case-insensitive.
    const r = this.#db.get(
      "SELECT * FROM projects WHERE forge = $forge AND full_name = $fullName COLLATE NOCASE",
      { forge, fullName },
    ) as ProjectRow | undefined;
    return r ? (rowToProject(r) as RepoProject) : undefined;
  }

  getBySlug(slug: string): Project | undefined {
    const r = this.#db.get("SELECT * FROM projects WHERE slug = $slug", { slug }) as
      ProjectRow | undefined;
    return r ? rowToProject(r) : undefined;
  }

  list(): Project[] {
    return (
      this.#db.query("SELECT * FROM projects ORDER BY name COLLATE NOCASE") as ProjectRow[]
    ).map(rowToProject);
  }

  update(id: string, patch: ProjectPatch): Project | undefined {
    const sets: string[] = [];
    const params: Params = { id, now: this.#now() };
    for (const [k, v] of Object.entries(patch) as [keyof ProjectPatch, unknown][]) {
      if (v === undefined) {
        continue;
      }
      sets.push(`${COLUMNS[k]} = $${k}`);
      params[k] = typeof v === "boolean" ? num(v) : (v as string | null);
    }
    if (sets.length === 0) {
      return this.get(id);
    }
    this.#db.run(
      `UPDATE projects SET ${sets.join(", ")}, updated_at = $now WHERE id = $id`,
      params,
    );
    return this.get(id);
  }

  setRepository(id: string, forge: ForgeId | null, fullName: string | null): Project | undefined {
    this.#db.run(
      "UPDATE projects SET forge = $forge, full_name = $fullName, updated_at = $now WHERE id = $id",
      { id, forge, fullName, now: this.#now() },
    );
    return this.get(id);
  }

  envCiphertext(id: string): string | null {
    return (
      (
        this.#db.get("SELECT env_ciphertext FROM projects WHERE id = $id", { id }) as
          { env_ciphertext: string | null } | undefined
      )?.env_ciphertext ?? null
    );
  }

  setEnvCiphertext(id: string, sealed: string | null): void {
    this.#db.run("UPDATE projects SET env_ciphertext = $v, updated_at = $now WHERE id = $id", {
      id,
      v: sealed,
      now: this.#now(),
    });
  }

  delete(id: string): boolean {
    return this.#db.run("DELETE FROM projects WHERE id = $id", { id }).changes > 0;
  }
}
