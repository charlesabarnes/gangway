import { servedByGangway, type Preview } from "@gangway/shared/domain";
import type { Org, Takedown } from "@gangway/shared/orgs-api";
import type { AuditSink } from "../audit/audit.ts";
import { actorId, type Actor } from "../auth/actor.ts";
import type { OrgsRepo } from "../db/repos/orgs.ts";
import type { TakedownsRepo } from "../db/repos/takedowns.ts";
import { AppError, conflict, errorMessage, notFound } from "../errors.ts";
import type { PreviewContext } from "../previews/context.ts";
import { destroy } from "../previews/destroy.ts";
import { sleepPreview } from "../previews/sleep.ts";
import { Blocks } from "./blocks.ts";
import { acrossOrgs, withOrg } from "./scope.ts";

export type SuspendDeps = {
  ctx: PreviewContext;
  orgs: OrgsRepo;
  takedowns: TakedownsRepo;
  audit: AuditSink;
};

const blocksOf = (ctx: PreviewContext): Blocks => ctx.blocks ?? (ctx.blocks = new Blocks());

function orgOf(d: SuspendDeps, id: string): Org {
  const org = d.orgs.get(id);
  if (!org) {
    throw notFound(`no such org: ${id}`);
  }
  return org;
}

/** Previews answer 410 and containers sleep; members may read and destroy, but change nothing. */
export async function suspendOrg(
  d: SuspendDeps,
  actor: Actor,
  id: string,
  reason: string,
): Promise<{ org: Org; slept: string[]; failed: string[] }> {
  const org = orgOf(d, id);
  if (org.home) {
    throw conflict("the home org runs the server itself; it cannot be suspended");
  }
  const previews = withOrg(org.id, () => d.ctx.previews.list());
  d.orgs.setState(org.id, "suspended");
  blocksOf(d.ctx).suspend(
    org.id,
    previews.map((p) => p.id),
  );
  d.audit.record(actor, "org.suspended", org.id, { new: { reason } });
  const { slept, failed } = await sleepAll(d.ctx, org.id, previews);
  return { org: orgOf(d, id), slept, failed };
}

async function sleepAll(
  ctx: PreviewContext,
  orgId: string,
  previews: Preview[],
): Promise<{ slept: string[]; failed: string[] }> {
  const awake = previews.filter((p) => p.state === "awake" && !servedByGangway(p));
  const results = await Promise.allSettled(
    awake.map((p) => withOrg(orgId, () => sleepPreview(ctx, p.id, "the org is suspended"))),
  );
  const slept: string[] = [];
  const failed: string[] = [];
  awake.forEach(({ id: pid }, i) => {
    const r = results[i];
    if (r?.status === "fulfilled") {
      slept.push(pid);
    } else {
      failed.push(pid);
      ctx.logger.warn("a suspended org's preview did not sleep", {
        previewId: pid,
        err: errorMessage(r?.reason),
      });
    }
  });
  return { slept, failed };
}

/** Serves the org again; its sleeping previews wake on their next visit. */
export function resumeOrg(d: SuspendDeps, actor: Actor, id: string): Org {
  const org = orgOf(d, id);
  d.orgs.setState(org.id, "active");
  blocksOf(d.ctx).resume(org.id);
  d.audit.record(actor, "org.resumed", org.id);
  return orgOf(d, id);
}

// Its hostnames answer 410, whatever is deployed there later, until lifted. A production keeps
// its volumes: it is blocked, not destroyed, until its project lets it go.
export async function takeDown(
  d: SuspendDeps,
  actor: Actor,
  previewId: string,
  reason: string,
): Promise<{ takedowns: Takedown[]; destroyed: boolean; kept?: string }> {
  const p = acrossOrgs(() => d.ctx.previews.get(previewId));
  if (!p || p.state === "destroyed") {
    throw notFound(`no such preview: ${previewId}`);
  }
  const hosts = d.ctx.table.forPreview(p.id).map((e) => e.hostname);
  const takedowns = d.takedowns.add(hosts, {
    previewId: p.id,
    orgId: p.orgId,
    reason,
    createdBy: actorId(actor),
  });
  blocksOf(d.ctx).takeDown(p.id, hosts);
  d.audit.record(actor, "preview.takedown", p.id, { new: { reason, orgId: p.orgId, hosts } });
  try {
    await withOrg(p.orgId, () => destroy(d.ctx, p.id, actor));
    return { takedowns, destroyed: true };
  } catch (e) {
    if (e instanceof AppError && e.code === "conflict") {
      return { takedowns, destroyed: false, kept: e.message };
    }
    throw e;
  }
}

export function liftTakedown(d: SuspendDeps, actor: Actor, hostname: string): Takedown {
  const t = d.takedowns.get(hostname);
  if (!t) {
    throw notFound(`${hostname} is not taken down`);
  }
  d.takedowns.remove(hostname);
  const stillDown = d.takedowns.list().some((o) => o.previewId === t.previewId);
  blocksOf(d.ctx).lift(hostname, stillDown, t.previewId);
  d.audit.record(actor, "preview.takedown.lifted", t.previewId, { old: { hostname } });
  return t;
}
