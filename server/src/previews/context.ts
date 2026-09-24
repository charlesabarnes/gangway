import type { AuditSink } from "../audit/audit.ts";
import type { BuildsRepo } from "../db/repos/builds.ts";
import type { CloneOptions } from "./source/git.ts";
import type { Clearance, Preview } from "@gangway/shared/domain";
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
import type { Policy } from "./policy.ts";
import type { PreviewStates } from "./state.ts";
import type { PreviewPasswordDeps } from "./password-deps.ts";

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
  baseDomain: () => string;
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
  addonSecret?: ((previewId: string, addon: AddonId) => string) | undefined;
  sources?: SourceStore | undefined;
  passwords?: PreviewPasswordDeps | undefined;
  /** Whether artifacts show the gangway mark unless a preview says otherwise. */
  brandDefault?: (() => boolean) | undefined;
  git?: Pick<CloneOptions, "gitPath" | "allowedHosts" | "timeoutMs"> | undefined;
};
