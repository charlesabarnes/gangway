import type { Preview } from "@gangway/shared/domain";
import { parseDuration } from "@gangway/shared/duration";
import { can, mayRebuild, type Actor } from "../auth/actor.ts";
import { conflict, forbidden, unprocessable } from "../errors.ts";
import type { PreviewContext } from "./context.ts";

export const EXTEND_FOREVER = "none";

// Adds `by` to what is left (or to now, if lapsed), or keeps it forever; never shortens a life.
export function extendPreview(
  ctx: Pick<PreviewContext, "previews" | "audit" | "now">,
  actor: Actor,
  previewId: string,
  by: string,
): Preview {
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
  const next = ms === null ? null : new Date(Math.max(old?.getTime() ?? 0, ctx.now()) + ms);
  // Already kept forever: adding time would make it expire.
  if (old === null) {
    return p;
  }
  ctx.previews.setTtlExpiresAt(previewId, next);
  ctx.audit.record(actor, "preview.extend", previewId, {
    old: old.toISOString(),
    new: next?.toISOString() ?? null,
  });
  return ctx.previews.get(previewId)!;
}
