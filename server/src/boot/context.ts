import { ArtifactLibrary } from "../artifacts/library.ts";
import { createHmac } from "node:crypto";
import type { Trigger } from "@gangway/shared/domain";
import { Passwords } from "../auth/password.ts";
import type { DockerClients } from "../docker/client.ts";
import { createComposeRunner, type ComposeRunner } from "../docker/runner.ts";
import { githubFullName } from "../forge/github/webhook.ts";
import type { Logger } from "../logger.ts";
import { DEFAULT_TIMINGS, type PreviewContext } from "../previews/context.ts";
import type { DeploySource } from "../previews/deploy-types.ts";
import { PreviewLogs } from "../previews/logs.ts";
import { PolicyResolver } from "../previews/policy.ts";
import { httpProbe, type RouteProbe } from "../previews/probe.ts";
import type { SiteStore } from "../previews/site.ts";
import type { SourceStore } from "../previews/source/store.ts";
import type { Workdirs } from "../previews/source/workdir.ts";
import { PreviewStates } from "../previews/state.ts";
import { SecretBox, loadOrCreateSecretsKey } from "../secrets/box.ts";
import { Secrets } from "../secrets/secrets.ts";
import { SETTINGS } from "../settings.ts";
import { noRoomForBuild } from "../previews/build-room.ts";
import { Slots } from "../util/async.ts";
import { parseBytes } from "../util/bytes.ts";
import { idleMs } from "../util/duration.ts";
import type { Core } from "./core.ts";
import type { Repos } from "./storage.ts";

const TEMPLATE_SETTING = {
  pr: SETTINGS.templatePr,
  api: SETTINGS.templateApi,
  manual: SETTINGS.templateManual,
} as const;

export type PreviewParts = {
  workdirs: Workdirs;
  sources: SourceStore;
  sites: SiteStore;
  dockerClients: DockerClients;
  overrides: {
    compose?: ComposeRunner;
    probe?: RouteProbe;
    timings?: Partial<PreviewContext["timings"]>;
  };
};

export type PreviewWiring = {
  ctx: PreviewContext;
  policy: PolicyResolver;
  secrets: Secrets;
  previewPasswords: Passwords;
  triggerDefault: (t: Trigger) => string;
};

export function createPreviewContext(core: Core, d: PreviewParts): PreviewWiring {
  const { config, settings, repos } = core;
  const o = d.overrides;
  const triggerDefault = (t: Trigger) => settings.get(TEMPLATE_SETTING[t]);
  const policy = createPolicy(repos, triggerDefault, core.logger);
  const secretsKey = loadOrCreateSecretsKey(core.stateDir);
  const secrets = new Secrets(repos.projects, repos.settings, new SecretBox(secretsKey), {
    audit: core.audit,
    previews: repos.previews,
  });
  const previewPasswords = new Passwords({ ln: 14 });
  const ctx: PreviewContext = {
    instance: config.instanceId,
    env: config.environment,
    origin: core.publicOrigin,
    previewDomain: core.previewDomain,
    domains: core.domains,
    shares: core.shares,
    policy,
    hosts: repos.hosts,
    previews: repos.previews,
    table: core.table,
    states: new PreviewStates(repos.previews, core.table, core.bus),
    bus: core.bus,
    workdirs: d.workdirs,
    compose: o.compose ?? composeFor(d.dockerClients, repos),
    logs: new PreviewLogs(core.stateDir),
    probe: o.probe ?? httpProbe,
    logger: core.logger.child({ mod: "previews" }),
    timings: { ...DEFAULT_TIMINGS, ...o.timings },
    now: Date.now,
    inflight: new Map(),
    teardowns: new Set(),
    builds: repos.builds,
    audit: core.audit,
    sources: d.sources,
    sites: d.sites,
    serveStatic: () => settings.get(SETTINGS.previewsServeStatic),
    artifacts: new ArtifactLibrary({
      themes: repos.artifactThemes,
      templates: repos.artifactTemplates,
      defaultTheme: () => settings.get(SETTINGS.artifactTheme),
    }),
    artifactCss: () => settings.get(SETTINGS.artifactCustomCss),
    limits: () => ({
      memoryBytes: parseBytes(settings.get(SETTINGS.previewsMemory)) ?? 0,
      cpus: settings.get(SETTINGS.previewsCpus),
      pids: settings.get(SETTINGS.previewsPids),
      containers: settings.get(SETTINGS.previewsContainers),
    }),
    quota: () => ({
      active: settings.get(SETTINGS.previewsActive),
      perUser: settings.get(SETTINGS.previewsActivePerUser),
    }),
    buildSlots: new Slots(
      () => settings.get(SETTINGS.previewsBuilds),
      () => settings.get(SETTINGS.previewsBuildQueue),
    ),
    buildTimeoutMs: () => idleMs(settings.get(SETTINGS.previewsBuildTimeout)),
    buildRoom: (host) =>
      noRoomForBuild(host, core.stateDir, {
        memoryBytes: parseBytes(settings.get(SETTINGS.previewsBuildMemory)) ?? 0,
        diskBytes: parseBytes(settings.get(SETTINGS.previewsBuildDisk)) ?? 0,
      }),
    privateAvailable: () => settings.get(SETTINGS.surfacesUi),
    // A separate semaphore, so a burst of preview password forms never queues an operator's login.
    passwords: {
      passwords: previewPasswords,
      defaultMode: () => settings.get(SETTINGS.previewPasswordMode),
      sharedSet: () => settings.get(SETTINGS.previewPasswordShared) !== null,
      loginDefault: () => settings.get(SETTINGS.previewPasswordLogin),
    },
    addonSecret: addonSecretFrom(secretsKey),
    secretsFor: (repoId, clearance) => secrets.valuesFor(repoId, clearance),
    secrets,
    ...orgPartsFrom(repos),
  };
  return { ctx, policy, secrets, previewPasswords, triggerDefault };
}

function orgPartsFrom(repos: Repos): Pick<PreviewContext, "orgSuffix" | "orgLimits"> {
  return {
    orgSuffix: (orgId) => {
      const org = repos.orgs.get(orgId);
      return org && !org.home ? org.slug : null;
    },
    orgLimits: (orgId) => repos.orgs.limitsOf(orgId)?.limits,
  };
}

function composeFor(dockerClients: DockerClients, repos: Repos): ComposeRunner {
  return createComposeRunner(dockerClients, (hostId, ok, err) => {
    repos.hosts.setState(hostId, ok ? "ready" : "unreachable", err);
  });
}

function createPolicy(
  repos: Repos,
  triggerDefault: (t: Trigger) => string,
  logger: Logger,
): PolicyResolver {
  return new PolicyResolver({
    templates: repos.templates,
    project: (ref) => repos.projects.find(ref),
    projectForSource: (source) => {
      const full = repoFullName(source);
      return full ? repos.projects.getByFullName("github", full) : undefined;
    },
    defaultFor: triggerDefault,
    logger: logger.child({ mod: "policy" }),
  });
}

function repoFullName(source: DeploySource): string | null {
  switch (source.kind) {
    case "pr":
      return source.repo;
    case "pushed":
      return source.pr.repo;
    case "git":
      return githubFullName(source.repo);
    case "tarball":
      return source.pr?.repo ?? null;
    case "image":
      return null;
  }
}

// Derived, not stored: it must be the same on every rebuild or compose recreates the database.
function addonSecretFrom(secretsKey: Buffer): NonNullable<PreviewContext["addonSecret"]> {
  return (previewId, addon) =>
    createHmac("sha256", secretsKey)
      .update(`gangway-addon\0${previewId}\0${addon}`)
      .digest("base64url")
      .slice(0, 32);
}
