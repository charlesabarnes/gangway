import { resolve } from "node:path";
import type { Host, Preview } from "@gangway/shared/domain";
import type { HostConfig } from "../config.ts";
import { migrate } from "../db/migrate.ts";
import {
  AuditRepo,
  BuildsRepo,
  CertificatesRepo,
  EventsRepo,
  HostsRepo,
  IdempotencyRepo,
  PreviewsRepo,
  ProjectsRepo,
  RolesRepo,
  RoutesRepo,
  TemplatesRepo,
  SessionsRepo,
  SqliteSettingsStore,
  TokensRepo,
  UsersRepo,
} from "../db/repos/index.ts";
import { OAuthGrantsRepo } from "../db/repos/oauth-grants.ts";
import { openDatabase } from "../db/sqlite.ts";
import type { Db } from "../db/types.ts";
import { seedHosts } from "../hosts/seed.ts";
import type { Logger } from "../logger.ts";
import { entryPassword } from "../previews/password.ts";
import { SourceStore } from "../previews/source/store.ts";
import { Workdirs } from "../previews/source/workdir.ts";
import type { RouteTable } from "../routing/table.ts";

const MIGRATIONS = resolve(import.meta.dir, "../../migrations");

export type Repos = {
  audit: AuditRepo;
  builds: BuildsRepo;
  certificates: CertificatesRepo;
  events: EventsRepo;
  hosts: HostsRepo;
  idempotency: IdempotencyRepo;
  oauthGrants: OAuthGrantsRepo;
  previews: PreviewsRepo;
  projects: ProjectsRepo;
  roles: RolesRepo;
  routes: RoutesRepo;
  sessions: SessionsRepo;
  settings: SqliteSettingsStore;
  templates: TemplatesRepo;
  tokens: TokensRepo;
  users: UsersRepo;
};

export function openStorage(path: string, logger: Logger): { db: Db; repos: Repos } {
  const { db, journalMode } = openDatabase({ path });
  const migrated = migrate(db, MIGRATIONS);
  logger.info("database ready", { journalMode, applied: migrated.applied });
  return { db, repos: openRepos(db) };
}

function openRepos(db: Db): Repos {
  return {
    audit: new AuditRepo(db),
    builds: new BuildsRepo(db),
    certificates: new CertificatesRepo(db),
    events: new EventsRepo(db),
    hosts: new HostsRepo(db),
    idempotency: new IdempotencyRepo(db),
    oauthGrants: new OAuthGrantsRepo(db),
    previews: new PreviewsRepo(db),
    projects: new ProjectsRepo(db),
    roles: new RolesRepo(db),
    routes: new RoutesRepo(db),
    sessions: new SessionsRepo(db),
    settings: new SqliteSettingsStore(db),
    templates: new TemplatesRepo(db),
    tokens: new TokensRepo(db),
    users: new UsersRepo(db),
  };
}

export function seedConfiguredHosts(
  configured: readonly HostConfig[],
  hosts: HostsRepo,
  logger: Logger,
): Host[] {
  const seeded = seedHosts(configured, hosts);
  for (const h of seeded) {
    if (h.capabilities.includes("preview") && h.capabilities.includes("runner")) {
      logger.warn(
        "host declares both preview and runner capabilities: untrusted PR code would share a host with CI jobs",
        { hostId: h.id },
      );
    }
  }
  return seeded;
}

export type RestoreDeps = {
  stateDir: string;
  repos: Pick<Repos, "previews" | "routes" | "builds">;
  table: RouteTable;
  logger: Logger;
};

export async function restoreState(
  d: RestoreDeps,
): Promise<{ workdirs: Workdirs; sources: SourceStore }> {
  const all = new Map(d.repos.previews.list({ includeDestroyed: true }).map((p) => [p.id, p]));
  hydrateRoutes(d, all);
  const workdirs = new Workdirs(d.stateDir);
  await workdirs.prune();
  const sources = new SourceStore(d.stateDir);
  await pruneSources(sources, all);
  cancelOrphanedBuilds(d.repos.builds, d.logger);
  return { workdirs, sources };
}

function hydrateRoutes(d: RestoreDeps, all: Map<string, Preview>): void {
  const { previews, routes } = d.repos;
  d.table.hydrate(
    routes.all().flatMap((route) => {
      const p = all.get(route.previewId);
      return p
        ? [
            {
              route,
              hostId: p.hostId,
              project: p.project,
              visibility: p.visibility,
              state: p.state,
              password: entryPassword(previews.passwordOf(p.id)),
              passwordLogin: p.passwordLogin,
            },
          ]
        : [];
    }),
  );
}

async function pruneSources(sources: SourceStore, all: Map<string, Preview>): Promise<void> {
  for (const id of await sources.ids()) {
    const p = all.get(id);
    if (!p || p.state === "destroyed") await sources.remove(id);
  }
}

function cancelOrphanedBuilds(builds: BuildsRepo, logger: Logger): void {
  const orphanedBuilds = builds.cancelRunning();
  if (orphanedBuilds > 0)
    logger.info("marked builds interrupted by the last shutdown as cancelled", {
      builds: orphanedBuilds,
    });
}
