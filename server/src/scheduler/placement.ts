import {
  servedByGangway,
  type Host,
  type HostCapability,
  type Preview,
} from "@gangway/shared/domain";
import { AppError } from "../errors.ts";

export type PlacementRequest = {
  capability: HostCapability;
  hostId?: string | undefined;
  orgId?: string | undefined;
};

type Endpoint = Pick<
  Host,
  "dockerHost" | "expectName" | "publishBind" | "upstream" | "ports" | "orgId"
>;

export const endpointOf = (h: Endpoint) =>
  JSON.stringify([h.dockerHost, h.expectName, h.publishBind, h.upstream, h.ports, h.orgId]);

/** At claim, with no await before it: the host chosen earlier must still be in service, unmoved. */
export function checkStillThere(hosts: readonly Host[], chosen: Host): void {
  const now = hosts.find((h) => h.id === chosen.id);
  if (!now || now.draining || endpointOf(now) !== endpointOf(chosen)) {
    throw new AppError(
      "unavailable",
      `host "${chosen.id}" changed or began draining while the preview was being prepared; deploy it again`,
    );
  }
}

// A site has no container, so it never keeps a host in service.
export const containersOn = (previews: readonly Preview[]) =>
  previews.filter((p) => !servedByGangway(p)).length;

export const usableBy = (h: Host, orgId: string | undefined) =>
  h.orgId === null || h.orgId === orgId;

export function place(req: PlacementRequest, hosts: readonly Host[]): Host {
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
