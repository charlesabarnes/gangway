import type { WatermarkChoice } from "@gangway/shared/domain";
import { orgScope } from "../../tenancy/scope.ts";
import type { CreatePreview } from "./preview-inputs.ts";

export const watermarkColumn = (w: WatermarkChoice | undefined): string | null =>
  w === "on" || w === "off" ? w : null;

export const choiceColumns = (p: CreatePreview) => ({
  watermark: watermarkColumn(p.watermark),
  domain: p.domain ?? null,
});

export const orgColumns = (p: CreatePreview) => ({
  org: orgOf(p),
  bytes: p.bytes ?? 0,
  reserved: p.reservedBytes ?? 0,
});

function orgOf(p: CreatePreview): string {
  const s = orgScope();
  if (s !== "fleet" && s.org !== p.orgId) {
    throw new Error("a preview may only be created in the request's own org");
  }
  return p.orgId;
}

export const labelColumns = (p: CreatePreview) => ({
  title: p.title ?? null,
  icon: p.icon?.name ?? null,
  iconColor: p.icon?.color ?? null,
});
