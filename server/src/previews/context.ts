/**
 * Everything the preview service layer needs, in one bag. No HTTP types: the
 * REST handler, the webhook receiver and the MCP tool are each a thin adapter over the
 * functions that take this.
 */
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
import type { PreviewPasswordDeps } from "./password.ts";

export type PreviewTimings = {
  /** `compose up` returning -> every service running and healthy. */
  startTimeoutMs: number;
  /** Healthy -> the routed port actually answering HTTP. */
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
  /** The template a deploy follows, and its repository if any. */
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
  /** One GET's status, for `deploy`'s `check` paths. Absent: `httpStatus`. */
  statusProbe?: StatusProbe | undefined;
  logger: Logger;
  timings: PreviewTimings;
  now: () => number;
  /** Deploys still running in this process, so destroy can cancel one and wait for it. */
  inflight: Map<string, { abort: AbortController; done: Promise<Preview> }>;
  /** Teardowns running in this process. With `inflight`, the reconciler's do-not-touch list. */
  teardowns: Set<string>;
  docker?: string | undefined;
  builds: BuildsRepo;
  /** False when `private` previews could not be opened: the UI (and its login page) is off. */
  privateAvailable?: (() => boolean) | undefined;
  audit: AuditSink;
  /**
   * The secrets a preview receives at a clearance: the global map, plus the
   * repository's when it has one. Absent: no `.env` is written.
   */
  secretsFor?:
    ((repoId: string | null, clearance: Clearance) => Record<string, string>) | undefined;
  /**
   * An add-on's password for a preview: derived, so the sidecar's config is the
   * same on every rebuild and compose never recreates the database. Absent: add-ons are refused.
   */
  addonSecret?: ((previewId: string, addon: AddonId) => string) | undefined;
  /** Uploaded sources, kept for the editor and for rebuilds. Absent: nothing is kept. */
  sources?: SourceStore | undefined;
  /**
   * Hashing preview passwords, and the server-wide default. Absent: only `inherit`/`none` work.
   */
  passwords?: PreviewPasswordDeps | undefined;
  /** Overrides for `git clone`: the allowed hosts, and (in tests) a stand-in binary. */
  git?: Pick<CloneOptions, "gitPath" | "allowedHosts" | "timeoutMs"> | undefined;
};
