/**
 * Placement (§9): "The scheduler is the ONLY place placement is decided."
 *
 * Trivial while there is one host, and every call site goes through it anyway -- that is
 * the point. As long as no other code assumes where work runs, collapsing to one host
 * and splitting later are both config changes with no migration.
 */
import type { Host, HostCapability } from "@gangway/shared/domain";
import { AppError } from "../errors.ts";

export type PlacementRequest = {
  capability: HostCapability;
  /** An explicit operator choice (the Deploy screen's host picker). Still validated. */
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

  // `unknown` is placeable: a freshly seeded host has not been probed yet, and refusing
  // it would make the first deploy after boot fail for no reason. `unreachable` and
  // `error` are not -- we asked, and the answer was no.
  const usable = capable.filter((h) => h.state === "ready" || h.state === "unknown");
  const pick = usable.find((h) => h.state === "ready") ?? usable[0];
  if (!pick) {
    throw new AppError("unavailable", `no reachable host with the "${req.capability}" capability`);
  }
  return pick;
}
