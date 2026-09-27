import type { Domain, Project } from "@gangway/shared/domain";
import { domainsProblem, isDomainName } from "@gangway/shared/hostname";
import type { DomainsRepo } from "../db/repos/domains.ts";
import type { ProjectsRepo } from "../db/repos/projects.ts";
import { unprocessable } from "../errors.ts";
import { SETTINGS, type Settings } from "../settings.ts";
import type { CertUnit } from "../tls/types.ts";
import { challengeTarget } from "./claims.ts";

export type RegistryDeps = {
  settings: Settings;
  domains: DomainsRepo;
  projects: Pick<ProjectsRepo, "get">;
  /** GANGWAY_PREVIEW_DOMAINS: wildcard domains pinned by the environment, beside previewDomain. */
  pinned: readonly string[];
};

type Snapshot = {
  rows: Domain[];
  /** The org's active wildcard claims; the pinned domains join them on read. */
  org: string[];
  /** Active wildcards a project claimed for itself. */
  byProject: Map<string, string[]>;
  /** An active exact hostname and the preview it answers for. */
  aliases: Map<string, string>;
  /** The exact hostnames whose DNS was last seen reaching gangway. */
  routable: Set<string>;
  /** Every wildcard gangway answers under, kept for the default domain it was built with. */
  all?: { defaultDomain: string; list: string[] };
};

/**
 * The domains gangway answers for and which one a preview is named under. Reads come from a
 * snapshot, so the request path never touches the database; every write goes through refresh.
 */
export class DomainRegistry {
  readonly #d: RegistryDeps;
  #snap: Snapshot | null = null;
  readonly #listeners = new Set<() => void>();

  constructor(d: RegistryDeps) {
    this.#d = d;
    for (const name of d.pinned)
      if (!isDomainName(name))
        throw new Error(`GANGWAY_PREVIEW_DOMAINS: "${name}" is not a domain name`);
    const problem = domainsProblem(this.control(), [this.defaultDomain(), ...d.pinned]);
    if (problem) throw new Error(problem);
  }

  control(): string {
    return this.#d.settings.get(SETTINGS.baseDomain);
  }

  /** Where a preview is named when neither it nor its project chose a domain. */
  defaultDomain(): string {
    return this.#d.settings.get(SETTINGS.previewDomain) || this.control();
  }

  /** The wildcard domains the environment pins; they need no claim. */
  pinned(): string[] {
    return [...new Set([this.defaultDomain(), ...this.#d.pinned])];
  }

  /** Every wildcard gangway answers under, for telling a preview host from a stray one. */
  wildcards(): readonly string[] {
    const s = this.#snapshot();
    const defaultDomain = this.defaultDomain();
    if (s.all?.defaultDomain !== defaultDomain) {
      const list = [...this.pinned(), ...s.org, ...[...s.byProject.values()].flat()];
      s.all = { defaultDomain, list: [...new Set(list)] };
    }
    return s.all.list;
  }

  /** The wildcard domains a preview of this project (or of none) may be named under. */
  availableTo(projectId: string | null): string[] {
    const s = this.#snapshot();
    const own = projectId === null ? [] : (s.byProject.get(projectId) ?? []);
    return [...new Set([...this.pinned(), ...s.org, ...own])];
  }

  /** Refuses a domain this project may not choose, naming the ones it may. */
  assertAvailable(name: string, projectId: string | null): void {
    const options = this.availableTo(projectId);
    if (!options.includes(name))
      throw unprocessable(
        `"${name}" is not a domain previews here can use; choose one of ${options.join(", ")}`,
        { domain: name, options },
      );
  }

  /**
   * The preview's own choice, then its project's, then the default. A choice that stopped being
   * available (its claim removed) falls through rather than failing a redeploy.
   */
  resolve(choice: {
    preview?: string | null | undefined;
    project?: Pick<Project, "id" | "domain"> | null | undefined;
  }): string {
    const projectId = choice.project?.id ?? null;
    const options = this.availableTo(projectId);
    for (const c of [choice.preview, choice.project?.domain])
      if (c && options.includes(c)) return c;
    return this.defaultDomain();
  }

  /** Where an existing preview belongs now: its choice, then its project's, then the default. */
  domainOf(preview: { domain: string | null; projectId: string | null }): string {
    const project = preview.projectId ? this.#d.projects.get(preview.projectId) : undefined;
    return this.resolve({ preview: preview.domain, project: project ?? null });
  }

  /** The preview an exact hostname answers for, if it is one. */
  aliasTarget(host: string): string | undefined {
    return this.#snapshot().aliases.get(host);
  }

  /**
   * Every active exact hostname for this preview, its own and its project's production ones;
   * routable keeps only those whose DNS already reaches gangway.
   */
  aliasesOf(previewId: string, o: { routable?: boolean } = {}): string[] {
    const s = this.#snapshot();
    const out: string[] = [];
    for (const [host, id] of s.aliases)
      if (id === previewId && (!o.routable || s.routable.has(host))) out.push(host);
    return out.sort();
  }

  rows(): readonly Domain[] {
    return this.#snapshot().rows;
  }

  /** A destroyed preview answers on none of its custom hostnames. */
  releasePreview(previewId: string): void {
    if (this.#d.domains.releasePreview(previewId)) this.refresh();
  }

  /**
   * The certificates gangway holds, the control domain's first (what a client with no SNI
   * gets): each pinned wildcard proves itself in its own zone, each claim at its delegate.
   */
  certUnits(): CertUnit[] {
    const control = this.control();
    const wildcard = (d: string) => [`*.${d}`, d];
    const units: CertUnit[] = [{ names: wildcard(control) }];
    for (const d of this.pinned()) if (d !== control) units.push({ names: wildcard(d) });
    for (const r of this.#snapshot().rows) {
      if (r.status !== "active") continue;
      const names = r.kind === "wildcard" ? wildcard(r.name) : [r.name];
      units.push({ names, delegate: challengeTarget(r, control) });
    }
    return units;
  }

  /** Refuses a control or default domain that is malformed or nests with another domain. */
  assertSettingsFit(control: string, defaultDomain: string): void {
    for (const name of [control, defaultDomain])
      if (
        name !== "" &&
        !isDomainName(name) &&
        name !== "localhost" &&
        !name.endsWith(".localhost")
      )
        throw unprocessable(`"${name}" is not a domain name`);
    const claimed = this.#snapshot()
      .rows.filter((r) => r.kind === "wildcard")
      .map((r) => r.name);
    const problem = domainsProblem(control, [
      defaultDomain || control,
      ...this.#d.pinned,
      ...claimed,
    ]);
    if (problem) throw unprocessable(problem);
  }

  /** Call after any write to domains, a project's production preview, or the domain settings. */
  refresh(): void {
    this.#snap = null;
    for (const fn of this.#listeners) fn();
  }

  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #snapshot(): Snapshot {
    if (this.#snap) return this.#snap;
    const rows = this.#d.domains.all();
    const org: string[] = [];
    const byProject = new Map<string, string[]>();
    const aliases = new Map<string, string>();
    const routable = new Set<string>();
    for (const r of rows) {
      if (r.status !== "active") continue;
      if (r.kind === "wildcard") {
        if (r.projectId === null) org.push(r.name);
        else byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r.name]);
        continue;
      }
      const target =
        r.previewId ??
        (r.projectId ? this.#d.projects.get(r.projectId)?.productionPreviewId : null);
      if (target) aliases.set(r.name, target);
      if (r.routingOk) routable.add(r.name);
    }
    this.#snap = { rows, org, byProject, aliases, routable };
    return this.#snap;
  }
}
