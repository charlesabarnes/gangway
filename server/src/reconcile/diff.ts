/**
 * Boot reconciliation (spec §11): SQLite says what *should* exist, the daemons say what *does*.
 *
 * `diff` is deliberately pure -- no dockerode, no SQLite, no clock. Everything it needs arrives
 * in one argument and everything it decides leaves as data. That is what turns §11's case table
 * into a unit test that runs in CI with no Docker daemon, and it is the only way the frightening
 * rows (stop a container, fail a preview) can be exercised at all.
 *
 * The rule the whole file is built around: an unreachable host is not an empty host. "I asked and
 * the answer was nothing" and "I could not ask" must never collapse into the same branch, because
 * the second one, treated as the first, deletes every route on the box.
 */

import type { Host, Preview, Route, Visibility } from "../../../shared/src/domain.ts";

/**
 * The `gangway.*` label schema version we write (§4.1). A container claiming a *higher* one was
 * written by a newer gangway that knows things this build does not, so it is not ours to destroy.
 */
export const GANGWAY_LABEL_VERSION = 1;

export type ContainerState = "running" | "exited";

/**
 * The `gangway.*` labels of §4.1, already parsed out of the daemon's string map by the caller.
 * Every field is optional: the orphan rows of §11 exist precisely because a container can carry
 * a partial or garbled copy of the route record.
 */
export type ScannedLabels = {
  previewId?: string | undefined;
  hostname?: string | undefined;
  service?: string | undefined;
  containerPort?: number | undefined;
  visibility?: Visibility | undefined;
  primary?: boolean | undefined;
  version?: number | undefined;
};

/**
 * One container as a host scan reports it. Deliberately minimal and owned by this module: the
 * reconciler must not depend on the shape of the docker client, or it stops being testable
 * without one.
 */
export type ScannedContainer = {
  id: string;
  /** The host whose daemon reported it. Reachability and upstreams are both per host. */
  hostId: Host["id"];
  /** The address the proxy dials to reach this host's published ports (`Host.upstream.address`). */
  upstreamHost: string;
  /** `null` when the daemon reports no published port: nothing can be routed to it. */
  publishedPort: number | null;
  state: ContainerState;
  labels: ScannedLabels;
};

/**
 * Per host, because hosts fail one at a time; a bare boolean is shorthand for "all of them".
 * A host *absent* from the map counts as unreachable -- the default answer to "did we hear from
 * this daemon?" has to be no, never "yes, and it was empty".
 */
export type HostReachability = boolean | ReadonlyMap<Host["id"], boolean>;

export type DiffInput = {
  dbRoutes: readonly Route[];
  previews: readonly Preview[];
  containers: readonly ScannedContainer[];
  hostReachable: HostReachability;
  /** Epoch ms. Passed in rather than read, so the function stays pure and its output deterministic. */
  now: number;
  /**
   * Previews with a build genuinely in flight. Empty on boot -- a build cannot outlive the process
   * that was running it, which is exactly why `building` rows need rescuing after a restart.
   */
  liveBuilds?: ReadonlySet<string>;
};

export type LeaveAloneReason =
  /** Route and container agree; §11 row 1. Verify and continue, restart nothing. */
  | "in-sync"
  /** We could not ask this host. Nothing is known, so nothing is decided. */
  | "host-unreachable"
  /** `gangway.version` above ours: a newer gangway owns it. */
  | "newer-gangway"
  /** Already `asleep`; re-writing the state would be noise. */
  | "already-asleep"
  /** `failed`/`destroying`/`destroyed`: terminal, and not the reconciler's to revive. */
  | "preview-inactive"
  /** `building` with a build actually running -- reconciliation raced a real build. */
  | "build-in-flight"
  /** A route with no preview row. Broken, but repairing it is not §11's job. */
  | "unknown-preview"
  /** Ours and running, but the daemon reports no published port to compare against. */
  | "container-port-unknown"
  /** Exited and unclaimed. It holds no port, so the orphan argument does not apply. */
  | "container-exited";

export type StopOrphanReason =
  /** §11: "If labels are incomplete, stop it." */
  | "incomplete-labels"
  /** Two sources claim one hostname. SQLite is the source of truth (§4), so the container loses. */
  | "hostname-conflict"
  /** Complete labels, but no published port: it claims a hostname it cannot serve. */
  | "unroutable";

/** Every action carries the caller's clock so the writer does not have to invent one. */
type Stamped = { at: number };

export type Action = Stamped & (
  /**
   * Not in §11's table: a human can recreate a container by hand and the published port moves.
   * Without this row the route silently points at nothing.
   */
  | {
      kind: "UpdateUpstream";
      hostname: string;
      previewId: string;
      containerId: string;
      from: { host: string; port: number };
      to: { host: string; port: number };
    }
  /** Never a bulk start: sixty containers at once thrashes the box. Wake-on-request handles the rest. */
  | { kind: "MarkAsleep"; previewId: string }
  /** Rebuild the route row from the container's labels (§4.1). */
  | {
      kind: "AdoptRoute";
      containerId: string;
      hostId: string;
      hostname: string;
      previewId: string;
      service: string;
      containerPort: number;
      upstream: { host: string; port: number };
      primary: boolean;
      visibility: Visibility;
    }
  /** An orphan holding a port is worse than a missing preview. */
  | { kind: "StopOrphan"; containerId: string; hostId: string; hostname: string | null; reason: StopOrphanReason }
  /** The builder died mid-build; without this the row stays `building` forever. */
  | { kind: "MarkFailed"; previewId: string; error: string }
  | { kind: "LeaveAlone"; reason: LeaveAloneReason; hostname: string | null; containerId: string | null; warn: boolean }
);

/** `LeaveAlone` is the only outcome that touches nothing. Everything else writes or stops something. */
export const isMutating = (a: Action): boolean => a.kind !== "LeaveAlone";

/** Anomalies worth a log line even though we chose to do nothing about them. */
const WARNING_REASONS: ReadonlySet<LeaveAloneReason> = new Set<LeaveAloneReason>([
  "newer-gangway", "unknown-preview", "container-port-unknown",
]);

type CompleteLabels = {
  previewId: string;
  hostname: string;
  service: string;
  containerPort: number;
  visibility: Visibility;
  primary: boolean;
};

/**
 * "Complete" means: enough to rebuild the route row of §4. `visibility` and `primary` are allowed
 * to be missing and resolve to the safe side -- a preview wrongly served as private is a support
 * ticket, one wrongly served as public is a leak, and a route wrongly marked non-primary is cosmetic.
 */
const completeLabels = (l: ScannedLabels): CompleteLabels | null => {
  if (!l.previewId || !l.hostname || !l.service) return null;
  if (l.containerPort === undefined || !Number.isInteger(l.containerPort) || l.containerPort <= 0) return null;
  return {
    previewId: l.previewId,
    hostname: l.hostname,
    service: l.service,
    containerPort: l.containerPort,
    visibility: l.visibility ?? "private",
    primary: l.primary ?? false,
  };
};

const reachabilityOf = (r: HostReachability): ((hostId: string) => boolean) =>
  typeof r === "boolean" ? () => r : (hostId) => r.get(hostId) ?? false;

export const diff = (input: DiffInput): Action[] => {
  const { now } = input;
  const liveBuilds = input.liveBuilds ?? new Set<string>();
  const reachable = reachabilityOf(input.hostReachable);

  const leave = (
    reason: LeaveAloneReason,
    where: { hostname?: string | null; containerId?: string | null } = {},
  ): Action => ({
    kind: "LeaveAlone", at: now, reason,
    hostname: where.hostname ?? null,
    containerId: where.containerId ?? null,
    warn: WARNING_REASONS.has(reason),
  });

  // Sorted once so the output order is a function of the data, not of scan order. Everything
  // below is Map lookups over these, so the whole pass is O(n log n), not O(n^2).
  const routes = [...input.dbRoutes].sort((a, b) => (a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0));
  const containers = [...input.containers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const previewsById = new Map<string, Preview>(input.previews.map((p) => [p.id, p]));
  const routesByHostname = new Map<string, Route>(input.dbRoutes.map((r) => [r.hostname, r]));

  const containersByHostname = new Map<string, ScannedContainer[]>();
  for (const c of containers) {
    const h = c.labels.hostname;
    if (h === undefined) continue;
    const bucket = containersByHostname.get(h);
    if (bucket) bucket.push(c);
    else containersByHostname.set(h, [c]);
  }

  const actions: Action[] = [];
  const claimed = new Set<string>(); // hostnames adopted during this pass
  const matched = new Set<string>(); // container ids already accounted for by a route
  const settled = new Set<string>(); // previews whose state we have already decided

  // Pass 1 -- what SQLite says should exist.
  for (const route of routes) {
    const preview = previewsById.get(route.previewId);
    if (!preview) {
      actions.push(leave("unknown-preview", { hostname: route.hostname }));
      continue;
    }
    if (!reachable(preview.hostId)) {
      // The load-bearing branch: no container evidence was collected for this host, so no
      // conclusion may be drawn from its absence. No state change, destructive or otherwise.
      actions.push(leave("host-unreachable", { hostname: route.hostname }));
      continue;
    }

    // A container matches a route only when it agrees on BOTH hostname and preview: same
    // hostname under a different preview is the collision case, not a match.
    const candidate = (containersByHostname.get(route.hostname) ?? [])
      .find((c) => c.state === "running" && c.labels.previewId === route.previewId);

    if (candidate) {
      matched.add(candidate.id);
      if (candidate.publishedPort === null) {
        actions.push(leave("container-port-unknown", { hostname: route.hostname, containerId: candidate.id }));
      } else if (candidate.publishedPort === route.upstream.port && candidate.upstreamHost === route.upstream.host) {
        actions.push(leave("in-sync", { hostname: route.hostname, containerId: candidate.id }));
      } else {
        actions.push({
          kind: "UpdateUpstream", at: now, hostname: route.hostname, previewId: route.previewId,
          containerId: candidate.id,
          from: { host: route.upstream.host, port: route.upstream.port },
          to: { host: candidate.upstreamHost, port: candidate.publishedPort },
        });
      }
      continue;
    }

    // Route exists, nothing running for it. One decision per preview, not per route.
    if (settled.has(preview.id)) continue;

    if (preview.state === "building") {
      if (liveBuilds.has(preview.id)) {
        actions.push(leave("build-in-flight", { hostname: route.hostname }));
      } else {
        settled.add(preview.id);
        actions.push({
          kind: "MarkFailed", at: now, previewId: preview.id,
          error: "build did not survive a gangway restart: no container and no live build",
        });
      }
      continue;
    }
    if (preview.state === "asleep") {
      actions.push(leave("already-asleep", { hostname: route.hostname }));
      continue;
    }
    if (preview.state === "failed" || preview.state === "destroying" || preview.state === "destroyed") {
      actions.push(leave("preview-inactive", { hostname: route.hostname }));
      continue;
    }
    settled.add(preview.id);
    actions.push({ kind: "MarkAsleep", at: now, previewId: preview.id });
  }

  // Pass 2 -- what the daemons say does exist, minus everything a route already claimed.
  for (const c of containers) {
    const labelHostname = c.labels.hostname ?? null;

    if (!reachable(c.hostId)) {
      // Defensive: a scan of an unreachable host cannot have produced containers, but if a caller
      // hands us stale ones we must not act on them either.
      actions.push(leave("host-unreachable", { hostname: labelHostname, containerId: c.id }));
      continue;
    }
    if (matched.has(c.id)) continue;

    if ((c.labels.version ?? GANGWAY_LABEL_VERSION) > GANGWAY_LABEL_VERSION) {
      actions.push(leave("newer-gangway", { hostname: labelHostname, containerId: c.id }));
      continue;
    }
    if (c.state !== "running") {
      // Checked before the orphan rows on purpose: an exited container holds no port, so the
      // "orphan holding a port" argument for stopping it does not apply.
      actions.push(leave("container-exited", { hostname: labelHostname, containerId: c.id }));
      continue;
    }

    const labels = completeLabels(c.labels);
    if (!labels) {
      actions.push({ kind: "StopOrphan", at: now, containerId: c.id, hostId: c.hostId, hostname: labelHostname, reason: "incomplete-labels" });
      continue;
    }
    if (routesByHostname.has(labels.hostname) || claimed.has(labels.hostname)) {
      // It survived pass 1 unmatched, so SQLite's row for this hostname belongs to someone else.
      actions.push({ kind: "StopOrphan", at: now, containerId: c.id, hostId: c.hostId, hostname: labels.hostname, reason: "hostname-conflict" });
      continue;
    }
    if (c.publishedPort === null) {
      actions.push({ kind: "StopOrphan", at: now, containerId: c.id, hostId: c.hostId, hostname: labels.hostname, reason: "unroutable" });
      continue;
    }

    claimed.add(labels.hostname);
    actions.push({
      kind: "AdoptRoute", at: now, containerId: c.id, hostId: c.hostId,
      hostname: labels.hostname, previewId: labels.previewId, service: labels.service,
      containerPort: labels.containerPort,
      upstream: { host: c.upstreamHost, port: c.publishedPort },
      primary: labels.primary, visibility: labels.visibility,
    });
  }

  return actions;
};
