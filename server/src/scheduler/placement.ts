import type { Host, HostCapability } from "@gangway/shared/domain";
import { AppError } from "../errors.ts";

export type PlacementRequest = {
  capability: HostCapability;
  hostId?: string | undefined;
};

export function place(req: PlacementRequest, hosts: readonly Host[]): Host {
  const capable = hosts.filter((h) => h.capabilities.includes(req.capability));

  if (req.hostId !== undefined) {
    const chosen = capable.find((h) => h.id === req.hostId);
    if (!chosen) {
      throw new AppError(
        "unprocessable",
        `host "${req.hostId}" does not exist or lacks the "${req.capability}" capability`,
      );
    }
    return chosen;
  }

  // unknown is placeable: a freshly seeded host has not been probed yet.
  const usable = capable.filter((h) => h.state === "ready" || h.state === "unknown");
  const pick = usable.find((h) => h.state === "ready") ?? usable[0];
  if (!pick) {
    throw new AppError("unavailable", `no reachable host with the "${req.capability}" capability`);
  }
  return pick;
}
