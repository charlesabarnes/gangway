import type { Host, HostCapability } from "@gangway/shared/domain";
import { AppError } from "../errors.ts";

export type PlacementRequest = {
  capability: HostCapability;
  hostId?: string | undefined;
  /** The org the preview is for: it may use shared hosts and its own, never another org's. */
  orgId?: string | undefined;
};

const usableBy = (h: Host, orgId: string | undefined) => h.orgId === null || h.orgId === orgId;

export function place(req: PlacementRequest, hosts: readonly Host[]): Host {
  // Another org's host is left out before anything is said about it, so a refusal names none.
  const capable = hosts.filter(
    (h) => usableBy(h, req.orgId) && h.capabilities.includes(req.capability),
  );

  if (req.hostId !== undefined) {
    const chosen = capable.find((h) => h.id === req.hostId);
    if (!chosen) {
      throw new AppError(
        "unprocessable",
        `host "${req.hostId}" does not exist or lacks the "${req.capability}" capability`,
      );
    }
    if (chosen.draining) {
      throw new AppError("unavailable", `host "${req.hostId}" is draining`);
    }
    return chosen;
  }

  // unknown is placeable: a freshly seeded host has not been probed yet.
  const usable = capable.filter(
    (h) => !h.draining && (h.state === "ready" || h.state === "unknown"),
  );
  // An org's own host before a shared one, and a ready one before one not probed yet.
  const own = usable.filter((h) => h.orgId !== null);
  const pick = [...own, ...usable.filter((h) => h.orgId === null)].find((h) => h.state === "ready");
  const chosen = pick ?? own[0] ?? usable[0];
  if (!chosen) {
    throw new AppError("unavailable", `no reachable host with the "${req.capability}" capability`);
  }
  return chosen;
}
