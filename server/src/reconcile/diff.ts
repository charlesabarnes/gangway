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

export const diff = (input: DiffInput): Action[] => {
  const { now } = input;
  const liveBuilds = input.liveBuilds ?? new Set<string>();
  const reachable = reachabilityOf(input.hostReachable);

  const leave = (
    reason: LeaveAloneReason,
    where: { hostname?: string | null; containerId?: string | null } = {},
  ): Action => ({
    kind: "LeaveAlone",
    at: now,
    reason,
    hostname: where.hostname ?? null,
    containerId: where.containerId ?? null,
    warn: WARNING_REASONS.has(reason),
  });

  const routes = [...input.dbRoutes].sort((a, b) =>
    a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0,
  );
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
  const claimed = new Set<string>();
  const matched = new Set<string>();
  const settled = new Set<string>();

  for (const route of routes) {
    const preview = previewsById.get(route.previewId);
    if (!preview) {
      actions.push(leave("unknown-preview", { hostname: route.hostname }));
      continue;
    }
    if (!reachable(preview.hostId)) {
      // An unreachable host is not an empty host: decide nothing from missing containers.
      actions.push(leave("host-unreachable", { hostname: route.hostname }));
      continue;
    }

    // Same hostname under a different preview is a collision, not a match.
    const candidate = (containersByHostname.get(route.hostname) ?? []).find(
      (c) => c.state === "running" && c.labels.previewId === route.previewId,
    );

    if (candidate) {
      matched.add(candidate.id);
      if (candidate.publishedPort === null) {
        actions.push(
          leave("container-port-unknown", { hostname: route.hostname, containerId: candidate.id }),
        );
      } else if (
        candidate.publishedPort === route.upstream.port &&
        candidate.upstreamHost === route.upstream.host
      ) {
        actions.push(leave("in-sync", { hostname: route.hostname, containerId: candidate.id }));
      } else {
        actions.push({
          kind: "UpdateUpstream",
          at: now,
          hostname: route.hostname,
          previewId: route.previewId,
          containerId: candidate.id,
          from: { host: route.upstream.host, port: route.upstream.port },
          to: { host: candidate.upstreamHost, port: candidate.publishedPort },
        });
      }
      continue;
    }

    if (settled.has(preview.id)) continue;

    if (preview.state === "building") {
      if (liveBuilds.has(preview.id)) {
        actions.push(leave("build-in-flight", { hostname: route.hostname }));
      } else {
        settled.add(preview.id);
        actions.push({
          kind: "MarkFailed",
          at: now,
          previewId: preview.id,
          error: "build did not survive a gangway restart: no container and no live build",
        });
      }
      continue;
    }
    if (preview.state === "asleep") {
      actions.push(leave("already-asleep", { hostname: route.hostname }));
      continue;
    }
    if (
      preview.state === "failed" ||
      preview.state === "destroying" ||
      preview.state === "destroyed"
    ) {
      actions.push(leave("preview-inactive", { hostname: route.hostname }));
      continue;
    }
    settled.add(preview.id);
    actions.push({ kind: "MarkAsleep", at: now, previewId: preview.id });
  }

  for (const c of containers) {
    const labelHostname = c.labels.hostname ?? null;

    if (!reachable(c.hostId)) {
      actions.push(leave("host-unreachable", { hostname: labelHostname, containerId: c.id }));
      continue;
    }
    if (matched.has(c.id)) continue;

    if ((c.labels.version ?? GANGWAY_LABEL_VERSION) > GANGWAY_LABEL_VERSION) {
      actions.push(leave("newer-gangway", { hostname: labelHostname, containerId: c.id }));
      continue;
    }
    if (c.state !== "running") {
      actions.push(leave("container-exited", { hostname: labelHostname, containerId: c.id }));
      continue;
    }

    const labels = completeLabels(c.labels);
    if (!labels) {
      actions.push({
        kind: "StopOrphan",
        at: now,
        containerId: c.id,
        hostId: c.hostId,
        hostname: labelHostname,
        reason: "incomplete-labels",
      });
      continue;
    }
    if (routesByHostname.has(labels.hostname) || claimed.has(labels.hostname)) {
      actions.push({
        kind: "StopOrphan",
        at: now,
        containerId: c.id,
        hostId: c.hostId,
        hostname: labels.hostname,
        reason: "hostname-conflict",
      });
      continue;
    }
    if (c.publishedPort === null) {
      actions.push({
        kind: "StopOrphan",
        at: now,
        containerId: c.id,
        hostId: c.hostId,
        hostname: labels.hostname,
        reason: "unroutable",
      });
      continue;
    }

    claimed.add(labels.hostname);
    actions.push({
      kind: "AdoptRoute",
      at: now,
      containerId: c.id,
      hostId: c.hostId,
      hostname: labels.hostname,
      previewId: labels.previewId,
      service: labels.service,
      containerPort: labels.containerPort,
      upstream: { host: c.upstreamHost, port: c.publishedPort },
      primary: labels.primary,
      visibility: labels.visibility,
    });
  }

  return actions;
};
