/**
 * Everything the preview service layer needs, in one bag. NO HTTP types (ADR-0003): the
 * REST handler, the webhook receiver and the MCP tool are each a thin adapter over the
 * functions that take this.
 */
import type { Preview, Visibility } from "../../../shared/src/domain.ts";
import type { PublicOrigin } from "../../../shared/src/url.ts";
import type { HostsRepo } from "../db/repos/hosts.ts";
import type { PreviewsRepo } from "../db/repos/previews.ts";
import type { ComposeRunner } from "../docker/runner.ts";
import type { EventBus } from "../events/bus.ts";
import type { Logger } from "../logger.ts";
import type { RouteTable } from "../routing/table.ts";
import type { PreviewLogs } from "./logs.ts";
import type { RouteProbe } from "./probe.ts";
import type { Workdirs } from "./source/workdir.ts";
import type { PreviewStates } from "./state.ts";

export type PreviewTimings = {
  /** `compose up` returning -> every service running and healthy. */
  startTimeoutMs: number;
  /** Healthy -> the routed port actually answering HTTP. */
  probeTimeoutMs: number;
  pollIntervalMs: number;
};

export const DEFAULT_TIMINGS: PreviewTimings = { startTimeoutMs: 180_000, probeTimeoutMs: 60_000, pollIntervalMs: 1_000 };

export type PreviewContext = {
  instance: string;
  env: string;
  origin: PublicOrigin;
  baseDomain: () => string;
  defaults: () => { ttl: string; visibility: Visibility };
  hosts: HostsRepo;
  previews: PreviewsRepo;
  table: RouteTable;
  states: PreviewStates;
  bus: EventBus;
  logs: PreviewLogs;
  workdirs: Workdirs;
  compose: ComposeRunner;
  probe: RouteProbe;
  logger: Logger;
  timings: PreviewTimings;
  now: () => number;
  /** Deploys still running in this process, so destroy can cancel one and wait for it. */
  inflight: Map<string, { abort: AbortController; done: Promise<Preview> }>;
  /** Teardowns running in this process. With `inflight`, the reconciler's do-not-touch list. */
  teardowns: Set<string>;
  docker?: string | undefined;
};
