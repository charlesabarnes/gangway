import { servedByGangway, type Preview } from "@gangway/shared/domain";
import type { OrgLimits } from "@gangway/shared/orgs-api";
import { conflict, forbidden } from "../errors.ts";
import type { Blocks } from "./blocks.ts";

export type LimitsContext = {
  previews: { list(): Preview[] };
  orgLimits?: ((orgId: string) => OrgLimits | undefined) | undefined;
  blocks?: Blocks | undefined;
};

const live = (p: Preview) => !["failed", "destroying", "destroyed"].includes(p.state);
const mb = (bytes: number) => `${Math.ceil(bytes / 1_000_000)} MB`;

export function admitChange(ctx: Pick<LimitsContext, "blocks">, orgId: string): void {
  if (ctx.blocks?.suspended(orgId)) {
    throw forbidden("this org is suspended: its previews cannot be deployed, rebuilt or extended");
  }
}

/** What the org's plan allows of one more preview; a limit left out does not limit. */
export function admitDeploy(
  ctx: LimitsContext,
  orgId: string,
  o: { site: boolean; bytes: number; used: number },
): void {
  admitChange(ctx, orgId);
  const l = ctx.orgLimits?.(orgId);
  if (!l) {
    return;
  }
  if (!o.site && l.containers === false) {
    throw forbidden("this org's plan serves static sites and artifacts, not containers");
  }
  const mine = ctx.previews.list().filter((p) => p.orgId === orgId && live(p));
  const max = o.site ? l.maxSites : l.maxActive;
  const count = mine.filter((p) => servedByGangway(p) === o.site).length;
  if (max !== undefined && count >= max) {
    const what = o.site ? "sites" : "app previews";
    throw conflict(
      `this org already has ${count} ${what}, the most its plan allows; destroy one first`,
    );
  }
  checkStorage(ctx, orgId, o.used + o.bytes);
}

/** Refuses when the org's sites would keep `total` bytes, past what its plan allows. */
export function checkStorage(
  ctx: Pick<LimitsContext, "orgLimits">,
  orgId: string,
  total: number,
): void {
  const cap = ctx.orgLimits?.(orgId)?.storageBytes;
  if (cap !== undefined && total > cap) {
    throw conflict(
      `this would keep ${mb(total)} of sites, past the ${mb(cap)} the org's plan allows; destroy one first`,
    );
  }
}

/** The latest a preview of this org that started at `start` may live to; undefined: no cap. */
export function lifetimeCap(
  ctx: Pick<LimitsContext, "orgLimits">,
  orgId: string,
  start: number,
): number | undefined {
  const max = ctx.orgLimits?.(orgId)?.maxLifetimeMs;
  return max === undefined ? undefined : start + max;
}
