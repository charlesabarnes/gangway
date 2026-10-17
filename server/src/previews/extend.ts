import { must } from "@gangway/shared/must";
import type { Preview } from "@gangway/shared/domain";
import { parseDuration } from "@gangway/shared/duration";
import { can, mayRebuild, type Actor } from "../auth/actor.ts";
import { conflict, forbidden, unprocessable } from "../errors.ts";
import type { PreviewContext } from "./context.ts";
import { admitChange, lifetimeCap } from "../tenancy/limits.ts";

export const EXTEND_FOREVER = "none";

// Production must not lapse with the TTL it had as a preview: it is kept until destroyed.
export function keepForProduction(
  ctx: {
    previews: Pick<PreviewContext["previews"], "get" | "setTtlExpiresAt">;
    audit: PreviewContext["audit"];
  },
  actor: Actor,
  previewId: string,
): void {
  const old = ctx.previews.get(previewId)?.ttlExpiresAt;
  if (!old) {
    return;
  }
  ctx.previews.setTtlExpiresAt(previewId, null);
  ctx.audit.record(actor, "preview.extend", previewId, { old: old.toISOString(), new: null });
}

// Adds `by` to what is left (or to now, if lapsed), or keeps it forever; never shortens a life.
export function extendPreview(
  ctx: Pick<PreviewContext, "previews" | "audit" | "now" | "orgLimits" | "blocks">,
  actor: Actor,
  previewId: string,
  by: string,
): Preview {
  admitChange(ctx, actor.orgId);
  if (!can(actor, "previews.extend")) {
    throw forbidden('extending how long a preview lives needs "previews.extend"');
  }
  if (!mayRebuild(actor, ctx.previews.provenanceOf(previewId))) {
    throw forbidden(
      'this preview was deployed by someone else: extending it needs "previews.update" as well as "previews.extend"',
    );
  }
  const forever = by.trim() === EXTEND_FOREVER;
  const ms = forever ? null : parseDuration(by);
  if (!forever && ms === null) {
    throw unprocessable(`"${by}" is not a duration like 2h, 7d or 4w, or "${EXTEND_FOREVER}"`);
  }
  const p = ctx.previews.get(previewId);
  if (!p || p.state === "destroyed" || p.state === "destroying") {
    throw conflict("this preview is being torn down or already gone");
  }

  const old = p.ttlExpiresAt;
  const asked = ms === null ? null : Math.max(old?.getTime() ?? 0, ctx.now()) + ms;
  const cap = lifetimeCap(ctx, p.orgId, p.createdAt.getTime());
  const until = cap === undefined ? asked : Math.min(asked ?? cap, cap);
  const next = until === null ? null : new Date(until);
  // Kept forever, or at the plan's cap, counted from its start ("none" under a cap is the cap).
  if (old === null || (next !== null && next.getTime() <= old.getTime())) {
    return p;
  }
  ctx.previews.setTtlExpiresAt(previewId, next);
  ctx.audit.record(actor, "preview.extend", previewId, {
    old: old.toISOString(),
    new: next?.toISOString() ?? null,
  });
  return must(ctx.previews.get(previewId), "the preview just extended");
}
