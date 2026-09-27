import type { ClaimDeps } from "../domains/claims.ts";
import { publicClaimDns, type ClaimDns } from "../domains/dns-check.ts";
import type { Core } from "./core.ts";

/** What claiming, checking and removing a domain works with; stateless, so build it anywhere. */
export function claimDeps(
  core: Pick<Core, "domains" | "repos" | "table" | "audit" | "bus">,
  dns: ClaimDns = publicClaimDns(),
): ClaimDeps {
  return {
    registry: core.domains,
    domains: core.repos.domains,
    previews: core.repos.previews,
    hostnames: () => core.table.hostnames(),
    audit: core.audit,
    bus: core.bus,
    dns,
    now: Date.now,
  };
}
