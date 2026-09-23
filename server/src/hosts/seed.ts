/**
 * Hosts declared in config are upserted on every boot. Config is authoritative for HOW we
 * reach a host; the row's `state` is owned by the reconciler and is deliberately left
 * untouched by a re-seed.
 */
import type { Host } from "@gangway/shared/domain";
import type { HostConfig } from "../config.ts";
import type { HostsRepo } from "../db/repos/hosts.ts";

export function seedHosts(configured: readonly HostConfig[], repo: HostsRepo): Host[] {
  return configured.map((h) =>
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
    }),
  );
}
