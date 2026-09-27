import { can, type Actor } from "../auth/actor.ts";
import { forbidden } from "../errors.ts";
import type { PreviewContext } from "./context.ts";

/** Choosing a domain is its own permission, and the domain must be one this project may use. */
export function checkDomainChoice(
  ctx: Pick<PreviewContext, "domains">,
  actor: Actor,
  domain: string | null | undefined,
  projectId: string | null,
): void {
  if (domain === undefined || domain === null) return;
  if (!can(actor, "previews.domain"))
    throw forbidden('choosing a preview\'s domain needs "previews.domain"');
  ctx.domains?.assertAvailable(domain, projectId);
}

/**
 * Stored now, used on the next deploy or rebuild: the preview's hostnames are its routes, and
 * those only move when it is built again.
 */
export function setPreviewDomain(
  ctx: Pick<PreviewContext, "previews" | "audit" | "domains">,
  actor: Actor,
  previewId: string,
  domain: string | null,
): void {
  const preview = ctx.previews.get(previewId);
  if (!preview) return;
  if (domain === null && !can(actor, "previews.domain"))
    throw forbidden('choosing a preview\'s domain needs "previews.domain"');
  checkDomainChoice(ctx, actor, domain, preview.projectId);
  if (preview.domain === domain) return;
  ctx.previews.setDomain(previewId, domain);
  ctx.audit.record(actor, "preview.domain", previewId, { old: preview.domain, new: domain });
}
