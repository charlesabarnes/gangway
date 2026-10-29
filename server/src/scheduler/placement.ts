import {
  servedByGangway,
  type Host,
  type HostCapability,
  type Preview,
} from "@gangway/shared/domain";
import type { HostLoad } from "../db/repos/host-loads.ts";
import { AppError } from "../errors.ts";

export type { HostLoad };

export type PlacementRequest = {
  capability: HostCapability;
  hostId?: string | undefined;
  orgId?: string | undefined;
  /** The memory the smallest preview takes: hosts that can still fit it come first. */
  reserveBytes?: number | undefined;
};

const IDLE: HostLoad = { previews: 0, awakeBytes: 0 };

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

const freeBytes = (h: Host, load: HostLoad) =>
  h.capacity.memoryBytes === null ? null : h.capacity.memoryBytes - load.awakeBytes;

export function roomFor(h: Host, load: HostLoad = IDLE, bytes = 0): boolean {
  const free = freeBytes(h, load);
  const counted = h.capacity.maxPreviews === null || load.previews < h.capacity.maxPreviews;
  return counted && (free === null || free >= bytes);
}

/** Refuses a container preview its host cannot take; no await may sit between this and the claim. */
export function checkRoom(h: Host, load: HostLoad | undefined, bytes: number): void {
  if (!roomFor(h, load, bytes)) {
    throw new AppError(
      "unavailable",
      "there is no room for another preview on the server right now; try again in a few minutes",
      { hostId: h.id },
    );
  }
}

export function place(
  req: PlacementRequest,
  hosts: readonly Host[],
  loads: ReadonlyMap<string, HostLoad> = new Map(),
): Host {
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
  const [chosen] = usable.toSorted((a, b) => rank(a, b, loads, req.reserveBytes ?? 0));
  if (!chosen) {
    throw new AppError("unavailable", `no reachable host with the "${req.capability}" capability`);
  }
  return chosen;
}

// The org's own host, then one with room, then a ready one, then the most memory free.
function rank(a: Host, b: Host, loads: ReadonlyMap<string, HostLoad>, bytes: number): number {
  const la = loads.get(a.id) ?? IDLE;
  const lb = loads.get(b.id) ?? IDLE;
  const keys = (h: Host, l: HostLoad) => [
    h.orgId === null ? 1 : 0,
    roomFor(h, l, bytes) ? 0 : 1,
    h.state === "ready" ? 0 : 1,
    -(freeBytes(h, l) ?? Number.MAX_SAFE_INTEGER),
  ];
  const ka = keys(a, la);
  const kb = keys(b, lb);
  const i = ka.findIndex((v, n) => v !== kb[n]);
  return i === -1 ? 0 : (ka[i] ?? 0) - (kb[i] ?? 0);
}
