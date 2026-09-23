import { HostConfigSchema } from "../../src/config.ts";
import { HostsRepo } from "../../src/db/repos/index.ts";
import type { Db } from "../../src/db/types.ts";
import { seedHosts } from "../../src/hosts/seed.ts";

/** The hosts table with the one host a config would seed, `config` applied on top of the defaults. */
export function seededHosts(db: Db, config: Record<string, unknown> = {}): HostsRepo {
  const hosts = new HostsRepo(db);
  seedHosts([HostConfigSchema.parse(config)], hosts);
  return hosts;
}
