import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Host } from "@gangway/shared/domain";
import { publicOriginFor, type PublicOrigin } from "@gangway/shared/url";
import { Audit } from "../audit/audit.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/types.ts";
import { DomainRegistry } from "../domains/registry.ts";
import { EventBus } from "../events/bus.ts";
import type { Logger } from "../logger.ts";
import type { SiteStore } from "../previews/site.ts";
import type { SourceStore } from "../previews/source/store.ts";
import type { Workdirs } from "../previews/source/workdir.ts";
import { RouteTable } from "../routing/table.ts";
import { SETTINGS, Settings } from "../settings.ts";
import { Shares } from "../share/shares.ts";
import { listenerOrigin, QuickTunnels } from "../share/tunnels.ts";
import { parseDuration } from "@gangway/shared/duration";
import { isLocalDomain } from "@gangway/shared/hostname";
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
  domains: DomainRegistry;
  shares: Shares;
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
  // Throws at boot on a nested pair or a malformed GANGWAY_PREVIEW_DOMAINS.
  const domains = new DomainRegistry({
    settings,
    domains: repos.domains,
    projects: repos.projects,
    pinned: config.previewDomains,
  });
  const previewDomain = () => domains.defaultDomain();
  // Quick tunnels are for testing: only a local-only install, which has no other way out, shares
  // unless an admin says otherwise.
  settings.defaultTo(SETTINGS.previewsShare, () => isLocalDomain(domains.control()));
  const publicOrigin: PublicOrigin = { scheme: config.publicScheme, port: config.publicPort };
  const bus = new EventBus(repos.events, (e) => logger.warn("event listener threw", { err: e }));
  const shares = sharesFor(config, settings, bus, logger);
  const core: Core = {
    config,
    stateDir,
    logger,
    db,
    repos,
    settings,
    baseDomain,
    previewDomain,
    domains,
    shares,
    publicOrigin,
    origin: (label) =>
      publicOriginFor(label ? `${label}.${baseDomain()}` : baseDomain(), publicOrigin),
    bus,
    table: new RouteTable(repos.routes, (host) => domains.aliasTarget(host) ?? shares.target(host)),
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

const DAY_MS = 86_400_000;

function sharesFor(config: Config, settings: Settings, bus: EventBus, logger: Logger): Shares {
  return new Shares({
    provider: new QuickTunnels({ binary: config.cloudflaredPath }),
    origin: listenerOrigin(config.listenAddress, config.listenPort),
    enabled: () => settings.get(SETTINGS.previewsShare),
    maxTtlMs: () => parseDuration(settings.get(SETTINGS.previewsShareMaxTtl)) ?? DAY_MS,
    logger: logger.child({ mod: "share" }),
    onChange: (share, end) =>
      bus.publish(
        end ? "preview.share.ended" : "preview.share.started",
        end ? { url: share.url, reason: end } : { url: share.url, expiresAt: share.expiresAt },
        share.previewId,
      ),
  });
}
