import type { Host, Preview, Route, Visibility } from "@gangway/shared/domain";

export const GANGWAY_LABEL_VERSION = 1;

export type ContainerState = "running" | "exited";

export type ScannedLabels = {
  previewId?: string | undefined;
  hostname?: string | undefined;
  service?: string | undefined;
  containerPort?: number | undefined;
  visibility?: Visibility | undefined;
  primary?: boolean | undefined;
  version?: number | undefined;
};

export type ScannedContainer = {
  id: string;
  hostId: Host["id"];
  upstreamHost: string;
  publishedPort: number | null;
  state: ContainerState;
  labels: ScannedLabels;
};

// A host absent from the map counts as unreachable.
export type HostReachability = boolean | ReadonlyMap<Host["id"], boolean>;

export type DiffInput = {
  dbRoutes: readonly Route[];
  previews: readonly Preview[];
  containers: readonly ScannedContainer[];
  hostReachable: HostReachability;
  now: number;
  liveBuilds?: ReadonlySet<string>;
};

export type LeaveAloneReason =
  | "in-sync"
  | "host-unreachable"
  | "newer-gangway"
  | "already-asleep"
  | "preview-inactive"
  | "build-in-flight"
  | "unknown-preview"
  | "container-port-unknown"
  | "container-exited";

export type StopOrphanReason = "incomplete-labels" | "hostname-conflict" | "unroutable";

type Stamped = { at: number };

export type Action = Stamped &
  (
    | {
        kind: "UpdateUpstream";
        hostname: string;
        previewId: string;
        containerId: string;
        from: { host: string; port: number };
        to: { host: string; port: number };
      }
    | { kind: "MarkAsleep"; previewId: string }
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
    | {
        kind: "StopOrphan";
        containerId: string;
        hostId: string;
        hostname: string | null;
        reason: StopOrphanReason;
      }
    | { kind: "MarkFailed"; previewId: string; error: string }
    | {
        kind: "LeaveAlone";
        reason: LeaveAloneReason;
        hostname: string | null;
        containerId: string | null;
        warn: boolean;
      }
  );

export const isMutating = (a: Action): boolean => a.kind !== "LeaveAlone";

const WARNING_REASONS: ReadonlySet<LeaveAloneReason> = new Set<LeaveAloneReason>([
  "newer-gangway",
  "unknown-preview",
  "container-port-unknown",
]);

type CompleteLabels = {
  previewId: string;
  hostname: string;
  service: string;
  containerPort: number;
  visibility: Visibility;
  primary: boolean;
};

// Missing visibility resolves to private: wrongly private is safer than wrongly public.
const completeLabels = (l: ScannedLabels): CompleteLabels | null => {
  if (!l.previewId || !l.hostname || !l.service) return null;
  if (l.containerPort === undefined || !Number.isInteger(l.containerPort) || l.containerPort <= 0)
    return null;
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

type Pass = {
  now: number;
  liveBuilds: ReadonlySet<string>;
  reachable: (hostId: string) => boolean;
  previewsById: ReadonlyMap<string, Preview>;
  routesByHostname: ReadonlyMap<string, Route>;
  containersByHostname: ReadonlyMap<string, ScannedContainer[]>;
  claimed: Set<string>;
  matched: Set<string>;
  settled: Set<string>;
};

export const diff = (input: DiffInput): Action[] => {
  const routes = [...input.dbRoutes].sort((a, b) => byString(a.hostname, b.hostname));
  const containers = [...input.containers].sort((a, b) => byString(a.id, b.id));
  const pass: Pass = {
    now: input.now,
    liveBuilds: input.liveBuilds ?? new Set<string>(),
    reachable: reachabilityOf(input.hostReachable),
    previewsById: new Map<string, Preview>(input.previews.map((p) => [p.id, p])),
    routesByHostname: new Map<string, Route>(input.dbRoutes.map((r) => [r.hostname, r])),
    containersByHostname: byHostname(containers),
    claimed: new Set<string>(),
    matched: new Set<string>(),
    settled: new Set<string>(),
  };

  const actions: Action[] = [];
  for (const route of routes) {
    const action = routeAction(pass, route);
    if (action) actions.push(action);
  }
  for (const c of containers) {
    const action = containerAction(pass, c);
    if (action) actions.push(action);
  }
  return actions;
};

function byString(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function byHostname(containers: readonly ScannedContainer[]): Map<string, ScannedContainer[]> {
  const out = new Map<string, ScannedContainer[]>();
  for (const c of containers) {
    const h = c.labels.hostname;
    if (h === undefined) continue;
    const bucket = out.get(h);
    if (bucket) bucket.push(c);
    else out.set(h, [c]);
  }
  return out;
}

function leave(
  at: number,
  reason: LeaveAloneReason,
  where: { hostname?: string | null; containerId?: string | null } = {},
): Action {
  return {
    kind: "LeaveAlone",
    at,
    reason,
    hostname: where.hostname ?? null,
    containerId: where.containerId ?? null,
    warn: WARNING_REASONS.has(reason),
  };
}

function routeAction(p: Pass, route: Route): Action | null {
  const preview = p.previewsById.get(route.previewId);
  if (!preview) return leave(p.now, "unknown-preview", { hostname: route.hostname });
  if (!p.reachable(preview.hostId)) {
    // An unreachable host is not an empty host: decide nothing from missing containers.
    return leave(p.now, "host-unreachable", { hostname: route.hostname });
  }

  // Same hostname under a different preview is a collision, not a match.
  const candidate = (p.containersByHostname.get(route.hostname) ?? []).find(
    (c) => c.state === "running" && c.labels.previewId === route.previewId,
  );
  if (candidate) {
    p.matched.add(candidate.id);
    return upstreamAction(p.now, route, candidate);
  }

  if (p.settled.has(preview.id)) return null;
  return missingContainerAction(p, route, preview);
}

function upstreamAction(now: number, route: Route, candidate: ScannedContainer): Action {
  const where = { hostname: route.hostname, containerId: candidate.id };
  if (candidate.publishedPort === null) return leave(now, "container-port-unknown", where);
  if (
    candidate.publishedPort === route.upstream.port &&
    candidate.upstreamHost === route.upstream.host
  )
    return leave(now, "in-sync", where);
  return {
    kind: "UpdateUpstream",
    at: now,
    hostname: route.hostname,
    previewId: route.previewId,
    containerId: candidate.id,
    from: { host: route.upstream.host, port: route.upstream.port },
    to: { host: candidate.upstreamHost, port: candidate.publishedPort },
  };
}

function missingContainerAction(p: Pass, route: Route, preview: Preview): Action {
  const where = { hostname: route.hostname };
  switch (preview.state) {
    case "building":
      if (p.liveBuilds.has(preview.id)) return leave(p.now, "build-in-flight", where);
      p.settled.add(preview.id);
      return {
        kind: "MarkFailed",
        at: p.now,
        previewId: preview.id,
        error: "build did not survive a gangway restart: no container and no live build",
      };
    case "asleep":
      return leave(p.now, "already-asleep", where);
    case "failed":
    case "destroying":
    case "destroyed":
      return leave(p.now, "preview-inactive", where);
    default:
      p.settled.add(preview.id);
      return { kind: "MarkAsleep", at: p.now, previewId: preview.id };
  }
}

function containerAction(p: Pass, c: ScannedContainer): Action | null {
  const labelHostname = c.labels.hostname ?? null;
  const where = { hostname: labelHostname, containerId: c.id };
  if (!p.reachable(c.hostId)) return leave(p.now, "host-unreachable", where);
  if (p.matched.has(c.id)) return null;
  if ((c.labels.version ?? GANGWAY_LABEL_VERSION) > GANGWAY_LABEL_VERSION)
    return leave(p.now, "newer-gangway", where);
  if (c.state !== "running") return leave(p.now, "container-exited", where);

  const labels = completeLabels(c.labels);
  if (!labels) return stopOrphan(p.now, c, labelHostname, "incomplete-labels");
  if (p.routesByHostname.has(labels.hostname) || p.claimed.has(labels.hostname))
    return stopOrphan(p.now, c, labels.hostname, "hostname-conflict");
  if (c.publishedPort === null) return stopOrphan(p.now, c, labels.hostname, "unroutable");

  p.claimed.add(labels.hostname);
  return {
    kind: "AdoptRoute",
    at: p.now,
    containerId: c.id,
    hostId: c.hostId,
    hostname: labels.hostname,
    previewId: labels.previewId,
    service: labels.service,
    containerPort: labels.containerPort,
    upstream: { host: c.upstreamHost, port: c.publishedPort },
    primary: labels.primary,
    visibility: labels.visibility,
  };
}

function stopOrphan(
  at: number,
  c: ScannedContainer,
  hostname: string | null,
  reason: StopOrphanReason,
): Action {
  return { kind: "StopOrphan", at, containerId: c.id, hostId: c.hostId, hostname, reason };
}
