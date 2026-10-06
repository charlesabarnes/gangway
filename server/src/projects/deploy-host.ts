import type { Preview, Project } from "@gangway/shared/domain";
import { can, type Actor } from "../auth/actor.ts";
import { forbidden } from "../errors.ts";
import type { DomainView } from "../domains/claims.ts";

/** The label a deploy branch is named with under `domain`, and a custom hostname to claim, if any. */
export function deployHostOf(
  project: Pick<Project, "slug" | "deployHost">,
  domain: string,
): { label: string; custom: string | null } {
  const host = project.deployHost;
  if (host === null) {
    return { label: project.slug, custom: null };
  }
  if (!host.includes(".")) {
    return { label: host, custom: null };
  }
  const under = host.endsWith(`.${domain}`) ? host.slice(0, -domain.length - 1) : null;
  if (under !== null && !under.includes(".") && !under.includes("--")) {
    return { label: under, custom: null };
  }
  return { label: project.slug, custom: host };
}

export type DeployHostDeps = {
  domainOf(project: Project): string;
  preview(id: string): Preview | undefined;
  relabel(previewId: string, label: string): Map<string, string>;
  holds(project: Project, name: string): boolean;
  claim(actor: Actor, project: Project, name: string): DomainView;
};

/** Before saving: claim a custom hostname, and rename a live branch deploy in place. */
export function applyDeployHost(
  d: DeployHostDeps,
  actor: Actor,
  before: Project,
  next: Project,
): { renamed: Record<string, string>; claimed: DomainView | null } | null {
  const fields = (p: Project) => [p.slug, p.domain, p.deployHost].join("\n");
  if (fields(before) === fields(next)) {
    return null;
  }
  // Against the live deploy's own name, which may predate the setting: relabel skips a no-op.
  const { label, custom } = deployHostOf(next, d.domainOf(next));
  const claiming = custom !== null && !d.holds(next, custom);
  const prod = next.productionPreviewId === null ? undefined : d.preview(next.productionPreviewId);
  const live = prod?.source.kind === "tarball" && prod.source.branch !== undefined ? prod : null;
  if ((claiming || live) && !can(actor, "repos.domains")) {
    throw forbidden('changing a repository\'s production address needs "repos.domains"');
  }
  const claimed = claiming ? d.claim(actor, next, custom) : null;
  const renamed = live ? d.relabel(live.id, label) : new Map<string, string>();
  return { renamed: Object.fromEntries(renamed), claimed };
}
