import type { Preview, Project } from "@gangway/shared/domain";
import type { Actor } from "../auth/actor.ts";
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
  next: Project,
): { renamed: Record<string, string>; claimed: DomainView | null } {
  const { label, custom } = deployHostOf(next, d.domainOf(next));
  const claimed = custom !== null && !d.holds(next, custom) ? d.claim(actor, next, custom) : null;
  const prod = next.productionPreviewId === null ? undefined : d.preview(next.productionPreviewId);
  const built = prod?.source.kind === "tarball" && prod.source.branch !== undefined;
  const renamed = prod && built ? d.relabel(prod.id, label) : new Map<string, string>();
  return { renamed: Object.fromEntries(renamed), claimed };
}
