import { z } from "zod";
import type { Domain, Preview, Project } from "@gangway/shared/domain";
import { DomainNameSchema } from "@gangway/shared/domains-api";
import { can, type Actor } from "../auth/actor.ts";
import {
  checkDomain,
  claimDomain,
  domainsOf,
  removeDomain,
  type ClaimDeps,
  type DomainTarget,
  type DomainView,
} from "../domains/claims.ts";
import { forbidden, notFound, unprocessable } from "../errors.ts";
import { setPreviewDomain } from "../previews/domain.ts";
import { nameOf, resolveFor } from "./resolve.ts";
import { jsonObject, plain } from "./tool-specs.ts";
import type { ToolDeps } from "./tool-deps.ts";

export const DomainsArgs = z.object({
  target: z
    .preprocess(
      jsonObject,
      z.union([
        z.strictObject({ org: z.literal(true) }),
        z.strictObject({ project: z.string().min(1).max(64) }),
        z.strictObject({ preview: z.string().min(1).max(2048) }),
      ]),
    )
    .describe(
      '{preview: "<name>"} for one preview, {project: "<slug>"} for a repository\'s previews, or {org: true} for the whole server.',
    ),
  use: DomainNameSchema.nullable()
    .optional()
    .describe(
      "Name the target's previews under this domain (one of the available ones); null follows the project, then the server's default. Takes effect when each preview is next deployed or rebuilt.",
    ),
  claim: z
    .string()
    .max(253)
    .optional()
    .describe(
      'Claim a domain the user owns. "*.previews.client.com" is a wildcard every preview can be named under (org or project); "www.client.com" is one hostname for a preview, or for a project\'s production preview. The answer lists the two DNS records the user must add.',
    ),
  remove: DomainNameSchema.optional().describe("Give up a claimed domain."),
  check: z
    .boolean()
    .optional()
    .describe("Ask DNS now instead of waiting for the next minute's check."),
  production: z
    .string()
    .max(2048)
    .nullable()
    .optional()
    .describe("Project only: the preview the project's own hostnames answer for; null for none."),
});
export type DomainsArgs = z.infer<typeof DomainsArgs>;

export const DOMAINS_TOOL = {
  title: "Domains and custom hostnames",
  description:
    "Choose which domain previews are named under, claim the user's own domains (a wildcard for previews, or exact hostnames like www.client.com), and see what DNS to set. A claim is verified by a CNAME the user adds; gangway then gets its certificate. With only a target it lists the domain in use, the domains available and the claims with their status.",
  inputSchema: plain(DomainsArgs),
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

function claimDeps(d: ToolDeps): ClaimDeps {
  if (!d.domains) throw notFound("domains are not available on this server");
  return d.domains;
}

function targetOf(d: ToolDeps, actor: Actor, t: DomainsArgs["target"]): DomainTarget {
  if ("org" in t) return { kind: "org" };
  if ("project" in t) {
    const project = d.findProject?.(t.project);
    if (!project) throw notFound(`no such project: ${t.project}`);
    return { kind: "project", project };
  }
  return { kind: "preview", preview: resolveFor(d.ctx, actor, t.preview) };
}

const where = (d: ToolDeps, t: DomainTarget) =>
  t.kind === "org"
    ? "the server"
    : t.kind === "project"
      ? `project "${t.project.slug}"`
      : nameOf(d.ctx, t.preview);

function describeClaim(v: DomainView): string {
  const state =
    v.status === "active"
      ? v.routingOk
        ? "active"
        : "active; DNS does not send it here yet"
      : v.status === "pending"
        ? "waiting for DNS"
        : "gave up waiting; check again once DNS is set";
  const lines = [`- ${v.kind === "wildcard" ? `*.${v.name}` : v.name}: ${state}`];
  if (v.status !== "active" || !v.routingOk)
    for (const r of v.records) lines.push(`    ${r.type} ${r.name} -> ${r.value}  (${r.purpose})`);
  return lines.join("\n");
}

function useDomain(d: ToolDeps, c: ClaimDeps, actor: Actor, t: DomainTarget, use: string | null) {
  if (t.kind === "org")
    throw unprocessable(
      "the server's default domain is a setting: change it in Admin → Domains & traffic",
    );
  if (t.kind === "preview") return setPreviewDomain(d.ctx, actor, t.preview.id, use);
  if (!can(actor, "repos.domains"))
    throw forbidden('choosing a repository\'s domain needs "repos.domains"');
  if (use !== null) c.registry.assertAvailable(use, t.project.id);
  d.projects?.repo.update(t.project.id, { domain: use });
  c.audit.record(actor, "project.domain", t.project.id, { old: t.project.domain, new: use });
}

function setProduction(
  d: ToolDeps,
  c: ClaimDeps,
  actor: Actor,
  project: Project,
  ref: string | null,
) {
  if (!can(actor, "repos.domains"))
    throw forbidden('choosing a repository\'s production preview needs "repos.domains"');
  const preview: Preview | null = ref === null ? null : resolveFor(d.ctx, actor, ref);
  if (preview && preview.projectId !== project.id)
    throw unprocessable(`${nameOf(d.ctx, preview)} is not one of ${project.slug}'s previews`);
  d.projects?.repo.update(project.id, { productionPreviewId: preview?.id ?? null });
  c.audit.record(actor, "project.production", project.id, {
    old: project.productionPreviewId,
    new: preview?.id ?? null,
  });
  c.registry.refresh();
}

function claimed(c: ClaimDeps, t: DomainTarget, name: string): Domain {
  const found = domainsOf(c, t).find((v) => v.name === name);
  if (!found) throw notFound(`${name} is not claimed here`);
  return found;
}

export async function manageDomains(d: ToolDeps, actor: Actor, args: DomainsArgs) {
  const c = claimDeps(d);
  const t = targetOf(d, actor, args.target);
  const notes: string[] = [];
  if (args.claim !== undefined) {
    const wildcard = args.claim.startsWith("*.");
    const name = DomainNameSchema.parse(wildcard ? args.claim.slice(2) : args.claim);
    const kind = wildcard || t.kind === "org" ? "wildcard" : "exact";
    claimDomain(c, actor, t, { name, kind });
    notes.push(`claimed ${args.claim}: add the records below, then call again with check: true`);
  }
  if (args.remove !== undefined) {
    removeDomain(c, actor, claimed(c, t, args.remove));
    notes.push(`removed ${args.remove}`);
  }
  if (args.use !== undefined) {
    useDomain(d, c, actor, t, args.use);
    notes.push(
      `${where(d, t)} now uses ${args.use ?? "the next level's domain"}; each preview moves when it is next deployed or rebuilt`,
    );
  }
  if (args.production !== undefined) {
    if (t.kind !== "project") throw unprocessable("production is a project's");
    setProduction(d, c, actor, t.project, args.production);
    notes.push(`production is now ${args.production ?? "none"}`);
  }
  if (args.check) for (const v of domainsOf(c, t)) await checkDomain(c, v, actor);
  return [...notes, ...(notes.length ? [""] : []), summary(d, c, t)].join("\n");
}

function summary(d: ToolDeps, c: ClaimDeps, t: DomainTarget): string {
  const projectId =
    t.kind === "project" ? t.project.id : t.kind === "preview" ? t.preview.projectId : null;
  const lines = [`domains for ${where(d, t)}:`];
  if (t.kind === "preview") {
    const now = d.ctx.table.forPreview(t.preview.id)[0]?.hostname;
    const next = c.registry.domainOf(d.ctx.previews.get(t.preview.id) ?? t.preview);
    lines.push(
      `named under: ${next}${now && !now.endsWith(`.${next}`) ? ` (still ${now} until its next rebuild)` : ""}`,
    );
  } else if (t.kind === "project")
    lines.push(`named under: ${c.registry.resolve({ project: t.project })}`);
  else lines.push(`default: ${c.registry.defaultDomain()}`);
  lines.push(`available: ${c.registry.availableTo(projectId).join(", ")}`);
  const views = domainsOf(c, t);
  lines.push(views.length ? "claimed:" : "claimed: none", ...views.map(describeClaim));
  return lines.join("\n");
}
