import { parseDuration } from "@gangway/shared/duration";
import { isLocalDomain } from "@gangway/shared/hostname";
import { can, mayRebuild, type Actor } from "../auth/actor.ts";
import { AppError, conflict, errorMessage, forbidden, unprocessable } from "../errors.ts";
import type { Share } from "../share/shares.ts";
import type { PreviewContext } from "./context.ts";

type ShareCtx = Pick<PreviewContext, "shares" | "previews" | "table" | "audit" | "domains">;

export type ShareStatus = {
  /** Whether this server can share at all: switched on, and cloudflared is installed. */
  available: boolean;
  /** Previews answer only on the machine gangway runs on; a share is the way out. */
  local: boolean;
  maxTtlMs: number;
  share: Share | null;
};

/** What a visitor through a quick tunnel should know before it is sent. */
export const SHARE_LIMITS =
  "Anyone with the link can open it, as the preview's own password or sign-in allows. " +
  "Cloudflare quick tunnels are for testing: at most 200 requests at once, no server-sent " +
  "events, and a new link each time it is shared.";

export function shareStatus(ctx: ShareCtx, previewId: string): ShareStatus {
  const control = ctx.domains?.control();
  return {
    available: ctx.shares?.available() ?? false,
    local: control !== undefined && isLocalDomain(control),
    maxTtlMs: ctx.shares?.maxTtlMs() ?? 0,
    share: ctx.shares?.get(previewId) ?? null,
  };
}

function checkMayShare(ctx: ShareCtx, actor: Actor, previewId: string): void {
  if (!can(actor, "previews.share"))
    throw forbidden('sharing a preview publicly needs "previews.share"');
  if (!mayRebuild(actor, ctx.previews.provenanceOf(previewId)))
    throw forbidden(
      'this preview was deployed by someone else: sharing it needs "previews.update" as well as "previews.share"',
    );
}

/** Starts the preview's public link, or returns the one it has. */
export async function startShare(
  ctx: ShareCtx,
  actor: Actor,
  previewId: string,
  ttl?: string,
): Promise<Share> {
  checkMayShare(ctx, actor, previewId);
  const shares = ctx.shares;
  if (!shares?.available())
    throw new AppError(
      "unavailable",
      shares
        ? "sharing is off on this server, or cloudflared is not installed"
        : "this server cannot share previews",
    );
  const ttlMs = ttl === undefined ? undefined : parseDuration(ttl);
  if (ttlMs === null) throw unprocessable(`"${ttl}" is not a duration like 30m, 2h or 1d`);
  const preview = ctx.previews.get(previewId);
  if (!preview || preview.state === "destroyed" || ctx.table.forPreview(previewId).length === 0)
    throw conflict("this preview has no URL to share yet");

  const had = shares.get(previewId);
  let share: Share;
  try {
    share = await shares.start(previewId, ttlMs);
  } catch (e) {
    throw new AppError("bad_gateway", `could not open a tunnel: ${errorMessage(e)}`);
  }
  // Destroyed while cloudflared was starting: the destroy found nothing to stop.
  if (ctx.previews.get(previewId)?.state === "destroyed") {
    shares.stop(previewId, "destroyed");
    throw conflict("this preview was destroyed while its link was being made");
  }
  if (!had)
    ctx.audit.record(actor, "preview.share", previewId, {
      new: { url: share.url, expiresAt: new Date(share.expiresAt).toISOString() },
    });
  return share;
}

export function stopShare(ctx: ShareCtx, actor: Actor, previewId: string): Share | null {
  checkMayShare(ctx, actor, previewId);
  const ended = ctx.shares?.stop(previewId) ?? null;
  if (ended) ctx.audit.record(actor, "preview.unshare", previewId, { old: { url: ended.url } });
  return ended;
}
