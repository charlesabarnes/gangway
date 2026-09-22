import type { Clearance, ForgeId, ForkPolicy, PrTrigger, Project, RepoProject, Visibility } from "../../../../shared/src/domain.ts";
import type { Db, Params } from "../types.ts";
import { num, rowToProject, type ProjectRow } from "./mappers.ts";

export type CreateProject = {
  id: string; name: string; slug: string;
  /** Both or neither: a project with no repository takes images and tarballs only. */
  forge?: ForgeId | null | undefined; fullName?: string | null | undefined;
  installationId?: string | undefined; prTrigger?: PrTrigger | undefined;
  enabled?: boolean | undefined; disabledReason?: string | null | undefined; templateId?: string | null | undefined;
};

/** Absent AND undefined both mean "leave it": zod's optional output is passed straight through. */
export type ProjectPatch = {
  name?: string | undefined; slug?: string | undefined; enabled?: boolean | undefined; disabledReason?: string | null | undefined;
  installationId?: string | undefined; prTrigger?: PrTrigger | undefined;
  templateId?: string | null | undefined;
  visibility?: Visibility | null | undefined; ttl?: string | null | undefined; forks?: ForkPolicy | undefined; drafts?: boolean | undefined;
  prClearance?: Clearance | null | undefined; forkClearance?: Clearance | undefined;
};

const COLUMNS: Record<keyof ProjectPatch, string> = {
  name: "name", slug: "slug", enabled: "enabled", disabledReason: "disabled_reason", installationId: "installation_id",
  prTrigger: "pr_trigger", templateId: "template_id", visibility: "visibility", ttl: "ttl", forks: "forks", drafts: "drafts",
  prClearance: "pr_clearance", forkClearance: "fork_clearance",
};

/** Projects: the things you preview, and how their previews are shaped (ADR-0014). */
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
        id: p.id, name: p.name, slug: p.slug, forge: p.forge ?? null, fullName: p.fullName ?? null, installationId: p.installationId ?? "",
        prTrigger: p.prTrigger ?? "workflow", enabled: num(p.enabled ?? true), reason: p.disabledReason ?? null, templateId: p.templateId ?? null, now,
      },
    );
    return this.get(p.id)!;
  }

  get(id: string): Project | undefined {
    const r = this.#db.get<ProjectRow>("SELECT * FROM projects WHERE id = $id", { id });
    return r ? rowToProject(r) : undefined;
  }

  /** By id, else by slug: a workflow names its project by slug, the UI by id. */
  find(ref: string): Project | undefined {
    return this.get(ref) ?? this.getBySlug(ref);
  }

  getByFullName(forge: ForgeId, fullName: string): RepoProject | undefined {
    // NOCASE: GitHub treats `Owner/Repo` and `owner/repo` as one repository, and the OIDC
    // claim, the webhook and a person typing it need not agree on case.
    const r = this.#db.get<ProjectRow>("SELECT * FROM projects WHERE forge = $forge AND full_name = $fullName COLLATE NOCASE", { forge, fullName });
    return r ? (rowToProject(r) as RepoProject) : undefined;
  }

  getBySlug(slug: string): Project | undefined {
    const r = this.#db.get<ProjectRow>("SELECT * FROM projects WHERE slug = $slug", { slug });
    return r ? rowToProject(r) : undefined;
  }

  list(): Project[] {
    return this.#db.query<ProjectRow>("SELECT * FROM projects ORDER BY name COLLATE NOCASE").map(rowToProject);
  }

  /** A partial update; only the keys present are written. Returns the row afterwards. */
  update(id: string, patch: ProjectPatch): Project | undefined {
    const sets: string[] = [];
    const params: Params = { id, now: this.#now() };
    for (const [k, v] of Object.entries(patch) as [keyof ProjectPatch, unknown][]) {
      if (v === undefined) continue;
      sets.push(`${COLUMNS[k]} = $${k}`);
      params[k] = typeof v === "boolean" ? num(v) : (v as string | null);
    }
    if (sets.length === 0) return this.get(id);
    this.#db.run(`UPDATE projects SET ${sets.join(", ")}, updated_at = $now WHERE id = $id`, params);
    return this.get(id);
  }

  /** The repository is set once, when the project is made, or changed deliberately here. */
  setRepository(id: string, forge: ForgeId | null, fullName: string | null): Project | undefined {
    this.#db.run("UPDATE projects SET forge = $forge, full_name = $fullName, updated_at = $now WHERE id = $id", { id, forge, fullName, now: this.#now() });
    return this.get(id);
  }

  /** The sealed secrets map (ADR-0012); the repo never sees plaintext. */
  envCiphertext(id: string): string | null {
    return this.#db.get<{ env_ciphertext: string | null }>("SELECT env_ciphertext FROM projects WHERE id = $id", { id })?.env_ciphertext ?? null;
  }

  setEnvCiphertext(id: string, sealed: string | null): void {
    this.#db.run("UPDATE projects SET env_ciphertext = $v, updated_at = $now WHERE id = $id", { id, v: sealed, now: this.#now() });
  }

  /** Its previews keep running, unowned (ON DELETE SET NULL). */
  delete(id: string): boolean {
    return this.#db.run("DELETE FROM projects WHERE id = $id", { id }).changes > 0;
  }
}
