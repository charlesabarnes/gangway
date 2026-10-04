import type { ArtifactLibrary } from "../artifacts/library.ts";
import type { AuditSink } from "../audit/audit.ts";
import type { Secrets } from "../secrets/secrets.ts";
import type { BuildsRepo } from "../db/repos/builds.ts";
import type { CloneOptions } from "./source/git.ts";
import type { Clearance, Host, Preview } from "@gangway/shared/domain";
import type { AddonId } from "@gangway/shared/addons";
import type { PublicOrigin } from "@gangway/shared/url";
import type { HostsRepo } from "../db/repos/hosts.ts";
import type { PreviewsRepo } from "../db/repos/previews.ts";
import type { ComposeRunner } from "../docker/runner.ts";
import type { EventBus } from "../events/bus.ts";
import type { Logger } from "../logger.ts";
import type { RouteTable } from "../routing/table.ts";
import type { PreviewLogs } from "./logs.ts";
import type { RouteProbe, StatusProbe } from "./probe.ts";
import type { Workdirs } from "./source/workdir.ts";
import type { SourceStore } from "./source/store.ts";
import type { SiteStore } from "./site.ts";
import type { Policy } from "./policy.ts";
import type { PreviewStates } from "./state.ts";
import type { PreviewPasswordDeps } from "./password-deps.ts";
import type { PreviewLimits } from "./compose-model.ts";
import type { PreviewQuota } from "./quota.ts";
import type { DomainRegistry } from "../domains/registry.ts";
import type { Shares } from "../share/shares.ts";
import type { Slots } from "../util/async.ts";

export type PreviewTimings = {
  startTimeoutMs: number;
  probeTimeoutMs: number;
  pollIntervalMs: number;
};

export const DEFAULT_TIMINGS: PreviewTimings = {
  startTimeoutMs: 180_000,
  probeTimeoutMs: 60_000,
  pollIntervalMs: 1_000,
};

export type PreviewContext = {
  instance: string;
  env: string;
  origin: PublicOrigin;
  previewDomain: () => string;
  domains?: DomainRegistry | undefined;
  shares?: Shares | undefined;
  policy: Policy;
  hosts: HostsRepo;
  previews: PreviewsRepo;
  table: RouteTable;
  states: PreviewStates;
  bus: EventBus;
  logs: PreviewLogs;
  workdirs: Workdirs;
  compose: ComposeRunner;
  probe: RouteProbe;
  statusProbe?: StatusProbe | undefined;
  logger: Logger;
  timings: PreviewTimings;
  now: () => number;
  inflight: Map<string, { abort: AbortController; done: Promise<Preview> }>;
  teardowns: Set<string>;
  docker?: string | undefined;
  builds: BuildsRepo;
  privateAvailable?: (() => boolean) | undefined;
  audit: AuditSink;
  secretsFor?:
    ((repoId: string | null, clearance: Clearance) => Record<string, string>) | undefined;
  /** Org, project and preview secrets; a preview's own are read and written through it. */
  secrets?: Secrets | undefined;
  addonSecret?: ((previewId: string, addon: AddonId) => string) | undefined;
  sources?: SourceStore | undefined;
  /** Where gangway keeps the files it serves itself; without it every preview gets a container. */
  sites?: SiteStore | undefined;
  /** Whether a plain static upload is served by gangway (true) or by an nginx container. */
  serveStatic?: (() => boolean) | undefined;
  /** Artifact themes and templates; built-ins only when absent. */
  artifacts?: ArtifactLibrary | undefined;
  artifactCss?: (() => boolean) | undefined;
  limits?: (() => PreviewLimits) | undefined;
  quota?: (() => PreviewQuota) | undefined;
  buildSlots?: Slots | undefined;
  buildTimeoutMs?: (() => number) | undefined;
  buildRoom?: ((host: Host) => Promise<string | null>) | undefined;
  passwords?: PreviewPasswordDeps | undefined;
  git?: Pick<CloneOptions, "gitPath" | "allowedHosts" | "timeoutMs"> | undefined;
  orgSuffix?: ((orgId: string) => string | null) | undefined;
};

export type PlanningContext = Pick<
  PreviewContext,
  "instance" | "env" | "origin" | "docker" | "compose" | "previews" | "logger" | "limits"
>;

/** Running compose steps for a preview: builds, health waits and the logs they write. */
export type BuildingContext = Pick<
  PreviewContext,
  | "compose"
  | "docker"
  | "logs"
  | "logger"
  | "now"
  | "builds"
  | "buildSlots"
  | "buildTimeoutMs"
  | "buildRoom"
  | "states"
  | "probe"
  | "timings"
>;

/** Moving a preview between states, and the shared bookkeeping that keeps two moves apart. */
export type LifecycleContext = Pick<
  PreviewContext,
  | "compose"
  | "docker"
  | "logs"
  | "logger"
  | "now"
  | "probe"
  | "timings"
  | "states"
  | "previews"
  | "hosts"
  | "table"
  | "inflight"
  | "teardowns"
  | "policy"
>;

export type StaticContext = Pick<
  PreviewContext,
  "previews" | "states" | "sites" | "sources" | "serveStatic" | "artifacts" | "artifactCss"
>;
