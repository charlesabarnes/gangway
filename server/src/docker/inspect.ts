/**
 * Reading facts back off a container: which host port it actually published, whether it
 * is healthy, and which containers on a daemon are ours.
 *
 * Everything that decides anything is a pure function over plain inspect JSON. The
 * reconciler's hardest cases (§11) — "verify port", "rebuild the route from labels",
 * "an orphan holding a port is worse than a missing preview" — are all judgements about
 * a JSON blob, and they are worth testing against captured payloads rather than against
 * a live daemon that happens to be in the right state today.
 *
 * ADR-0004 means the published port SHOULD equal the port we allocated. `UpdateUpstream`
 * exists because a human can recreate a container by hand and move it, so we read the
 * real value rather than assuming ours.
 */
import type { Route } from "../../../shared/src/domain.ts";
import type { ContainerSummary, DockerClient } from "./client.ts";
import { MANAGED_FILTER, parseLabels, routeFromLabels, type GangwayLabels, type LabelParseFailure } from "./labels.ts";

export type PortProtocol = "tcp" | "udp" | "sctp";

/** One entry of `NetworkSettings.Ports[key]`. */
export type PortBindingJson = { HostIp?: string | undefined; HostPort?: string | undefined };

/** The subset of `GET /containers/{id}/json` we read. Structural — no dockerode types. */
export type InspectJson = {
  Id?: string | undefined;
  Name?: string | undefined;
  Created?: string | undefined;
  Image?: string | undefined;
  Config?: { Image?: string | undefined; Labels?: Record<string, string> | null | undefined } | undefined;
  State?:
    | {
        Status?: string | undefined;
        Running?: boolean | undefined;
        ExitCode?: number | undefined;
        StartedAt?: string | undefined;
        FinishedAt?: string | undefined;
        Health?: { Status?: string | undefined; FailingStreak?: number | undefined } | null | undefined;
      }
    | undefined;
  NetworkSettings?: { Ports?: Record<string, PortBindingJson[] | null> | null | undefined } | undefined;
};

export type PublishedPort = {
  containerPort: number;
  protocol: PortProtocol;
  hostIp: string;
  hostPort: number;
};

const PROTOCOLS: readonly PortProtocol[] = ["tcp", "udp", "sctp"];

/** `"8080/tcp"` -> `{ port: 8080, protocol: "tcp" }`. `"8080"` defaults to tcp. */
export function parsePortKey(key: string): { port: number; protocol: PortProtocol } | null {
  const slash = key.indexOf("/");
  const portPart = slash === -1 ? key : key.slice(0, slash);
  const protoPart = slash === -1 ? "tcp" : key.slice(slash + 1);
  if (!/^\d{1,5}$/.test(portPart)) return null;
  const port = Number(portPart);
  if (port < 1 || port > 65535) return null;
  if (!PROTOCOLS.includes(protoPart as PortProtocol)) return null;
  return { port, protocol: protoPart as PortProtocol };
}

/**
 * Every published binding, flattened. A container published with no explicit bind gets
 * two entries per port (0.0.0.0 and ::); an unpublished exposed port has a `null` value
 * and yields none, which is the distinction that matters to `findPublishedPort`.
 */
export function publishedPorts(inspect: InspectJson): PublishedPort[] {
  const ports = inspect.NetworkSettings?.Ports;
  if (!ports) return [];
  const out: PublishedPort[] = [];
  for (const [key, bindings] of Object.entries(ports)) {
    const parsed = parsePortKey(key);
    if (!parsed || !bindings) continue;
    for (const b of bindings) {
      const hostPort = Number(b.HostPort ?? "");
      if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) continue;
      out.push({
        containerPort: parsed.port,
        protocol: parsed.protocol,
        hostIp: b.HostIp ?? "",
        hostPort,
      });
    }
  }
  return out.sort((a, b) => a.containerPort - b.containerPort || a.hostPort - b.hostPort);
}

const isIpv4 = (ip: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);

/**
 * The binding for one container port. `bind` is `Host.publishBind`: when dockerd bound
 * both families we must return the one the proxy will actually dial, not whichever the
 * daemon listed first.
 */
export function findPublishedPort(
  inspect: InspectJson,
  containerPort: number,
  opts: { protocol?: PortProtocol; bind?: string } = {},
): PublishedPort | undefined {
  const protocol = opts.protocol ?? "tcp";
  const candidates = publishedPorts(inspect).filter(
    (p) => p.containerPort === containerPort && p.protocol === protocol,
  );
  if (candidates.length === 0) return undefined;
  if (opts.bind !== undefined && opts.bind !== "") {
    const exact = candidates.find((p) => p.hostIp === opts.bind);
    if (exact) return exact;
  }
  return candidates.find((p) => isIpv4(p.hostIp)) ?? candidates[0];
}

/**
 * `none` means no healthcheck is declared, which is NOT the same as unhealthy: §7.4
 * gates wake on healthchecks, and a service without one must be treated as ready rather
 * than hanging the wake forever.
 */
export type HealthState = "none" | "starting" | "healthy" | "unhealthy" | "unknown";

export function healthState(inspect: InspectJson): HealthState {
  const health = inspect.State?.Health;
  if (health === undefined || health === null) return "none";
  switch (health.Status) {
    case "starting": return "starting";
    case "healthy": return "healthy";
    case "unhealthy": return "unhealthy";
    default: return "unknown";
  }
}

export function isRunning(inspect: InspectJson): boolean {
  return inspect.State?.Running === true || inspect.State?.Status === "running";
}

/** Running, and either healthy or without a healthcheck to be unhealthy by. */
export function isReady(inspect: InspectJson): boolean {
  if (!isRunning(inspect)) return false;
  const h = healthState(inspect);
  return h === "healthy" || h === "none" || h === "unknown";
}

export function containerLabels(inspect: InspectJson): Record<string, string> {
  return inspect.Config?.Labels ?? {};
}

/** `/gw-acme-pr-123-api-1` -> `gw-acme-pr-123-api-1`. */
export function containerName(inspect: InspectJson): string {
  const n = inspect.Name ?? "";
  return n.startsWith("/") ? n.slice(1) : n;
}

/**
 * §11 row 1: "Route exists / container running -> verify port, continue."
 * `null` means agreement. Anything else is the `UpdateUpstream` case.
 */
export type PortDrift =
  | { kind: "no-binding"; expected: number }
  | { kind: "moved"; expected: number; actual: number };

export function portDrift(
  route: Pick<Route, "containerPort" | "upstream">,
  inspect: InspectJson,
  opts: { bind?: string } = {},
): PortDrift | null {
  const found = findPublishedPort(inspect, route.containerPort, opts);
  if (!found) return { kind: "no-binding", expected: route.upstream.port };
  if (found.hostPort !== route.upstream.port) {
    return { kind: "moved", expected: route.upstream.port, actual: found.hostPort };
  }
  return null;
}

/** What a managed-container scan yields per container. */
export type ManagedContainer = {
  id: string;
  name: string;
  project: string | null;
  state: string;
  labels: GangwayLabels;
  /** Rebuilt purely from labels (§4.1). No database, no second daemon call. */
  route: Route;
};

/** A container carrying `gangway.managed=true` whose labels we could not use. */
export type UnusableContainer = {
  id: string;
  name: string;
  state: string;
  failure: LabelParseFailure;
};

export type ManagedScan = {
  hostId: string;
  managed: ManagedContainer[];
  /**
   * Kept separate and NOT merged into `managed`: `future-version` entries must make the
   * reconciler warn and back off, and `malformed` ones are the orphans §11 says to stop.
   * Collapsing the two loses exactly the distinction that decides whether we destroy
   * someone's running preview.
   */
  unusable: UnusableContainer[];
};

/** Turn one listing entry into a scan row. Pure: the daemon call already happened. */
export function classifyContainer(c: ContainerSummary): ManagedContainer | UnusableContainer {
  const parsed = parseLabels(c.labels);
  if (!parsed.ok) {
    return { id: c.id, name: c.names[0] ?? c.id, state: c.state, failure: parsed };
  }
  return {
    id: c.id,
    name: c.names[0] ?? c.id,
    project: c.labels["com.docker.compose.project"] ?? parsed.labels.project,
    state: c.state,
    labels: parsed.labels,
    route: routeFromLabels(parsed.labels),
  };
}

const isManagedRow = (r: ManagedContainer | UnusableContainer): r is ManagedContainer =>
  "route" in r;

/**
 * §11 step 2: "query each host for containers with the `gangway.*` label prefix."
 * `all: true` on purpose — a stopped container still holds its name and, more to the
 * point, still owns its published port allocation.
 */
export async function scanManaged(
  client: Pick<DockerClient, "hostId" | "listContainers">,
): Promise<ManagedScan> {
  const containers = await client.listContainers({ all: true, filters: { label: [MANAGED_FILTER] } });
  const rows = containers.map(classifyContainer);
  return {
    hostId: client.hostId,
    managed: rows.filter(isManagedRow),
    unusable: rows.filter((r): r is UnusableContainer => !isManagedRow(r)),
  };
}
