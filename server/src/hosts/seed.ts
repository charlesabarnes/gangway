import type { Host } from "@gangway/shared/domain";
import type { HostConfig } from "../config.ts";
import type { HostsRepo } from "../db/repos/hosts.ts";

/** A config id that an API-registered host already uses is left alone and reported. */
export function seedHosts(
  configured: readonly HostConfig[],
  repo: HostsRepo,
  onClash: (id: string) => void = () => {},
): Host[] {
  const api = new Set(
    repo
      .list()
      .filter((h) => h.managedBy === "api")
      .map((h) => h.id),
  );
  return configured.flatMap((h) => {
    if (api.has(h.id)) {
      onClash(h.id);
      return [];
    }
    return [
      repo.upsert({
        id: h.id,
        name: h.name,
        dockerHost: h.dockerHost,
        expectName: h.expectName ?? null,
        capabilities: h.capabilities,
        publishBind: h.publishBind,
        upstream: {
          dial: h.upstreamDial,
          address: h.upstreamAddress,
          proxy: h.upstreamProxy ?? null,
        },
        ports: { rangeStart: h.portRangeStart, rangeEnd: h.portRangeEnd },
        managedBy: "config",
        orgId: null,
        capacity: { memoryBytes: null, maxPreviews: null },
      }),
    ];
  });
}

/**
 * A host gone from the config file is removed, or drained while previews still run there; a
 * later boot removes it once they have gone.
 */
export function retireUnlisted(
  configured: readonly HostConfig[],
  repo: HostsRepo,
  inUse: (hostId: string) => boolean,
): { removed: string[]; draining: string[] } {
  const listed = new Set(configured.map((h) => h.id));
  const out = { removed: [] as string[], draining: [] as string[] };
  for (const h of repo.list()) {
    if (h.managedBy !== "config" || listed.has(h.id)) {
      continue;
    }
    if (inUse(h.id)) {
      repo.setDraining(h.id, true);
      out.draining.push(h.id);
    } else {
      repo.remove(h.id);
      out.removed.push(h.id);
    }
  }
  return out;
}
