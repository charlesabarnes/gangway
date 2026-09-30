import { randomBytes } from "node:crypto";
import type { Domain, DomainKind, DomainStatus, Preview, Project } from "@gangway/shared/domain";
import { domainsProblem, isWithin, labelUnder } from "@gangway/shared/hostname";
import { must } from "@gangway/shared/must";
import type { AuditSink } from "../audit/audit.ts";
import { can, mayRebuild, type Actor } from "../auth/actor.ts";
import type { DomainsRepo } from "../db/repos/domains.ts";
import type { PreviewsRepo } from "../db/repos/previews.ts";
import { conflict, forbidden, unprocessable } from "../errors.ts";
import type { EventBus } from "../events/bus.ts";
import { ulid } from "../util/ulid.ts";
import type { ClaimDns } from "./dns-check.ts";
import type { DomainRegistry } from "./registry.ts";

/** Who a domain belongs to: the org (the whole server), a project, or one preview. */
export type DomainTarget =
  { kind: "org" } | { kind: "project"; project: Project } | { kind: "preview"; preview: Preview };

export type DnsRecord = { type: "CNAME" | "TXT"; name: string; value: string; purpose: string };
export type DomainView = Domain & { records: DnsRecord[] };

export type ClaimDeps = {
  registry: DomainRegistry;
  domains: DomainsRepo;
  previews: Pick<PreviewsRepo, "domainChosen" | "forgetDomain" | "provenanceOf" | "get">;
  hostnames: () => Iterable<string>;
  audit: AuditSink;
  bus?: EventBus | undefined;
  dns: ClaimDns;
  now: () => number;
};

/** A claim that never proved control in this long gives up; checking it again restarts it. */
export const CLAIM_PATIENCE_MS = 7 * 86_400_000;

const random = (n: number) => {
  const alphabet = "abcdefghjkmnpqrstvwxyz0123456789";
  return Array.from(randomBytes(n), (b) => alphabet[b % 32]).join("");
};

/** Where `_acme-challenge.<name>` must point: gangway answers certificate challenges there. */
export const challengeTarget = (d: Pick<Domain, "claimId">, control: string) =>
  `${d.claimId}.acme.${control}`;

export function viewOf(d: Domain, control: string): DomainView {
  const at = d.kind === "wildcard" ? `*.${d.name}` : d.name;
  return {
    ...d,
    records: [
      {
        type: "CNAME",
        name: `_acme-challenge.${d.name}`,
        value: challengeTarget(d, control),
        purpose: "proves you control the name, and lets gangway get its certificate",
      },
      {
        type: "CNAME",
        name: at,
        value: control,
        purpose:
          d.kind === "wildcard"
            ? "sends every preview name under it here"
            : "sends it here (an apex name needs ALIAS/ANAME, or the A records of " + `${control})`,
      },
    ],
  };
}

export function targetOf(d: Domain): DomainTarget["kind"] {
  if (d.previewId) {
    return "preview";
  }
  return d.projectId ? "project" : "org";
}

/** The permission each level asks for; a preview's also needs leave to change that preview. */
export function assertMayManage(
  deps: Pick<ClaimDeps, "previews">,
  actor: Actor,
  kind: DomainTarget["kind"],
  previewId?: string | null,
): void {
  if (kind === "org" && !can(actor, "domains.manage")) {
    throw forbidden('the server\'s own domains need "domains.manage"');
  }
  if (kind === "project" && !can(actor, "repos.domains")) {
    throw forbidden('a repository\'s domains need "repos.domains"');
  }
  if (kind === "preview") {
    if (!can(actor, "previews.domain")) {
      throw forbidden('a preview\'s hostnames need "previews.domain"');
    }
    if (previewId && !mayRebuild(actor, deps.previews.provenanceOf(previewId))) {
      throw forbidden(
        'this preview was deployed by someone else: changing its hostnames needs "previews.update"',
      );
    }
  }
}

function claimProblem(deps: ClaimDeps, name: string, kind: DomainKind): string | null {
  const control = deps.registry.control();
  if (isWithin(name, control)) {
    return `${name} is under gangway's own domain ${control}; name previews with a label instead`;
  }
  const rows = deps.domains.all();
  const wildcards = [
    ...new Set([
      ...deps.registry.pinned(),
      ...rows.filter((r) => r.kind === "wildcard").map((r) => r.name),
    ]),
  ];
  const under = wildcards.find((w) => isWithin(name, w));
  if (under) {
    return `${name} is under the preview domain ${under}, where gangway already names it`;
  }
  if (kind === "exact") {
    return null;
  }
  const nested = domainsProblem(control, [...wildcards, name]);
  if (nested) {
    return nested;
  }
  const clash = rows.find((r) => r.kind === "exact" && labelUnder(r.name, name) !== null);
  return clash ? `${clash.name} is already claimed as a hostname of its own` : null;
}

export function claimDomain(
  deps: ClaimDeps,
  actor: Actor,
  target: DomainTarget,
  req: { name: string; kind: DomainKind },
): DomainView {
  const previewId = target.kind === "preview" ? target.preview.id : null;
  assertMayManage(deps, actor, target.kind, previewId);
  if (target.kind === "preview" && req.kind === "wildcard") {
    throw unprocessable(
      "a preview claims hostnames; wildcard domains belong to a project or the org",
    );
  }
  if (target.kind === "org" && req.kind === "exact") {
    throw unprocessable("a hostname answers for one site: claim it on a project or a preview");
  }
  const taken = deps.domains.byName(req.name);
  if (taken) {
    throw conflict(`${req.name} is already claimed`, { domain: req.name });
  }
  const problem = claimProblem(deps, req.name, req.kind);
  if (problem) {
    throw unprocessable(problem, { domain: req.name });
  }

  const d = deps.domains.create({
    id: ulid(deps.now()),
    name: req.name,
    kind: req.kind,
    projectId: target.kind === "project" ? target.project.id : null,
    previewId,
    claimId: random(16),
    createdBy: actor.kind === "user" ? actor.userId : null,
  });
  deps.audit.record(actor, "domain.claimed", d.id, {
    new: { name: d.name, kind: d.kind, project: d.projectId, preview: d.previewId },
  });
  deps.registry.refresh();
  return viewOf(d, deps.registry.control());
}

/** Refused while a preview is named under it or anything still chooses it. */
export function removeDomain(deps: ClaimDeps, actor: Actor, d: Domain): void {
  assertMayManage(deps, actor, targetOf(d), d.previewId);
  if (d.kind === "wildcard") {
    const live = [...deps.hostnames()].find((h) => labelUnder(h, d.name));
    if (live) {
      throw conflict(`${live} is still named under ${d.name}; move or destroy it first`, {
        hostname: live,
      });
    }
    if (d.projectId === null && deps.previews.domainChosen(d.name)) {
      throw conflict(`a project or preview still chooses ${d.name}; choose another first`);
    }
    deps.previews.forgetDomain(d.name);
  }
  deps.domains.delete(d.id);
  deps.audit.record(actor, "domain.removed", d.id, {
    old: { name: d.name, kind: d.kind, project: d.projectId, preview: d.previewId },
  });
  deps.registry.refresh();
}

/**
 * Asks public DNS whether the claim holds: the challenge CNAME proves control and makes the
 * claim active for good; routing says whether the name reaches this server yet.
 */
export async function checkDomain(
  deps: ClaimDeps,
  claim: Domain,
  actor: Actor | null = null,
): Promise<DomainView> {
  // Someone asking again gives a claim that ran out of patience another week.
  if (claim.status === "failed" && actor) {
    deps.domains.retry(claim.id, deps.now());
  }
  const d = actor ? (deps.domains.get(claim.id) ?? claim) : claim;
  const control = deps.registry.control();
  const want = challengeTarget(d, control);
  const probe = d.kind === "wildcard" ? `gw-check-${random(8)}.${d.name}` : d.name;
  const [cnames, here, there] = await Promise.all([
    deps.dns.cnames(`_acme-challenge.${d.name}`),
    deps.dns.addresses(control),
    deps.dns.addresses(probe),
  ]);
  const owned = cnames.includes(want);
  const routingOk = there.some((a) => here.includes(a));
  const expired = deps.now() - d.createdAt.getTime() > CLAIM_PATIENCE_MS;
  const status = statusAfterCheck(owned || d.status === "active", expired);
  const lastError = checkError(d, { control, want }, { owned, routingOk });
  deps.domains.recordCheck(d.id, { status, routingOk, lastError });
  const after = must(deps.domains.get(d.id), "the domain just checked");
  if (after.status !== d.status || after.routingOk !== d.routingOk) {
    deps.registry.refresh();
    const payload = { domain: d.name, status: after.status, routingOk: after.routingOk };
    deps.bus?.publish(`domain.${after.status}`, payload, d.previewId);
  }
  if (after.status === "active" && d.status !== "active") {
    deps.audit.record(actor, "domain.verified", d.id, { new: { name: d.name } });
  }
  return viewOf(after, control);
}

function statusAfterCheck(active: boolean, expired: boolean): DomainStatus {
  if (active) {
    return "active";
  }
  return expired ? "failed" : "pending";
}

function checkError(
  d: Domain,
  at: { control: string; want: string },
  found: { owned: boolean; routingOk: boolean },
): string | null {
  if (!found.owned) {
    return `_acme-challenge.${d.name} is not yet a CNAME to ${at.want}`;
  }
  if (!found.routingOk) {
    const host = d.kind === "wildcard" ? `*.${d.name}` : d.name;
    return `${host} does not resolve to ${at.control} yet`;
  }
  return null;
}

const RECHECK_ACTIVE_MS = 3_600_000;

/** The domain-verify job: pending claims every run, active ones hourly for their routing. */
export async function checkDue(deps: ClaimDeps, signal?: AbortSignal): Promise<number> {
  const now = deps.now();
  const due = deps.domains
    .all()
    .filter(
      (d) =>
        d.status === "pending" ||
        (d.status === "active" && now - (d.checkedAt?.getTime() ?? 0) > RECHECK_ACTIVE_MS),
    );
  for (const d of due) {
    if (signal?.aborted) {
      break;
    }
    await checkDomain(deps, d);
  }
  return due.length;
}

export function domainsOf(deps: Pick<ClaimDeps, "domains" | "registry">, target: DomainTarget) {
  const control = deps.registry.control();
  return rowsFor(deps.domains, target).map((d) => viewOf(d, control));
}

function rowsFor(domains: DomainsRepo, target: DomainTarget): Domain[] {
  switch (target.kind) {
    case "org":
      return domains.all().filter((d) => d.projectId === null && d.previewId === null);
    case "project":
      return domains.forProject(target.project.id);
    case "preview":
      return domains.forPreview(target.preview.id);
  }
}
