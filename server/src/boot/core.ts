import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Host } from "@gangway/shared/domain";
import { domainPairProblem } from "@gangway/shared/hostname";
import { publicOriginFor, type PublicOrigin } from "@gangway/shared/url";
import { Audit } from "../audit/audit.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/types.ts";
import { EventBus } from "../events/bus.ts";
import type { Logger } from "../logger.ts";
import type { SiteStore } from "../previews/site.ts";
import type { SourceStore } from "../previews/source/store.ts";
import type { Workdirs } from "../previews/source/workdir.ts";
import { RouteTable } from "../routing/table.ts";
import { SETTINGS, Settings } from "../settings.ts";
import { UpdateCheck } from "../updates.ts";
import { openStorage, restoreState, seedConfiguredHosts, type Repos } from "./storage.ts";

export type Core = {
  config: Config;
  stateDir: string;
  logger: Logger;
  db: Db;
  repos: Repos;
  settings: Settings;
  baseDomain: () => string;
  previewDomain: () => string;
  publicOrigin: PublicOrigin;
  origin: (label: string) => string;
  bus: EventBus;
  table: RouteTable;
  audit: Audit;
  updates: UpdateCheck;
};

export type Opened = {
  core: Core;
  seeded: Host[];
  workdirs: Workdirs;
  sources: SourceStore;
  sites: SiteStore;
};

export async function openCore(config: Config, logger: Logger): Promise<Opened> {
  const stateDir = resolve(config.stateDir);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  const { db, repos } = openStorage(config.databasePath ?? join(stateDir, "gangway.db"), logger);
  const settings = new Settings(config.overrides, repos.settings);
  const baseDomain = () => settings.get(SETTINGS.baseDomain);
  const previewDomain = () => settings.get(SETTINGS.previewDomain) || baseDomain();
  const problem = domainPairProblem(baseDomain(), previewDomain());
  if (problem) throw new Error(problem);
  const publicOrigin: PublicOrigin = { scheme: config.publicScheme, port: config.publicPort };
  const core: Core = {
    config,
    stateDir,
    logger,
    db,
    repos,
    settings,
    baseDomain,
    previewDomain,
    publicOrigin,
    origin: (label) =>
      publicOriginFor(label ? `${label}.${baseDomain()}` : baseDomain(), publicOrigin),
    bus: new EventBus(repos.events, (e) => logger.warn("event listener threw", { err: e })),
    table: new RouteTable(repos.routes),
    audit: new Audit(repos.audit, logger.child({ mod: "audit" })),
    updates: new UpdateCheck({
      current: config.version,
      enabled: () => settings.get(SETTINGS.updatesCheck),
      logger: logger.child({ mod: "updates" }),
    }),
  };
  const seeded = seedConfiguredHosts(config.hosts, repos.hosts, logger);
  const { workdirs, sources, sites } = await restoreState({
    stateDir,
    repos,
    table: core.table,
    logger,
  });
  return { core, seeded, workdirs, sources, sites };
}
