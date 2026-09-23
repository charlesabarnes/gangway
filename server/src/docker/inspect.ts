import type { Route } from "@gangway/shared/domain";
import type { ContainerSummary, DockerClient } from "./client.ts";
import {
  MANAGED_FILTER,
  parseLabels,
  routeFromLabels,
  type GangwayLabels,
  type LabelParseFailure,
} from "./labels.ts";

export type PortProtocol = "tcp" | "udp" | "sctp";

export type PortBindingJson = { HostIp?: string | undefined; HostPort?: string | undefined };

export type InspectJson = {
  Id?: string | undefined;
  Name?: string | undefined;
  Created?: string | undefined;
  Image?: string | undefined;
  Config?:
    { Image?: string | undefined; Labels?: Record<string, string> | null | undefined } | undefined;
  State?:
    | {
        Status?: string | undefined;
        Running?: boolean | undefined;
        ExitCode?: number | undefined;
        StartedAt?: string | undefined;
        FinishedAt?: string | undefined;
        Health?:
          { Status?: string | undefined; FailingStreak?: number | undefined } | null | undefined;
      }
    | undefined;
  NetworkSettings?:
    { Ports?: Record<string, PortBindingJson[] | null> | null | undefined } | undefined;
};

export type PublishedPort = {
  containerPort: number;
  protocol: PortProtocol;
  hostIp: string;
  hostPort: number;
};

const PROTOCOLS: readonly PortProtocol[] = ["tcp", "udp", "sctp"];

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

// dockerd may bind both address families; pick the one the proxy dials.
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

// A service with no healthcheck counts as ready, or its wake would hang forever.
export type HealthState = "none" | "starting" | "healthy" | "unhealthy" | "unknown";

export function healthState(inspect: InspectJson): HealthState {
  const health = inspect.State?.Health;
  if (health === undefined || health === null) return "none";
  switch (health.Status) {
    case "starting":
      return "starting";
    case "healthy":
      return "healthy";
    case "unhealthy":
      return "unhealthy";
    default:
      return "unknown";
  }
}

export function isRunning(inspect: InspectJson): boolean {
  return inspect.State?.Running === true || inspect.State?.Status === "running";
}

export function isReady(inspect: InspectJson): boolean {
  if (!isRunning(inspect)) return false;
  const h = healthState(inspect);
  return h === "healthy" || h === "none" || h === "unknown";
}

export function containerLabels(inspect: InspectJson): Record<string, string> {
  return inspect.Config?.Labels ?? {};
}

export function containerName(inspect: InspectJson): string {
  const n = inspect.Name ?? "";
  return n.startsWith("/") ? n.slice(1) : n;
}

export type PortDrift =
  { kind: "no-binding"; expected: number } | { kind: "moved"; expected: number; actual: number };

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

export type ManagedContainer = {
  id: string;
  name: string;
  project: string | null;
  state: string;
  labels: GangwayLabels;
  route: Route;
};

export type UnusableContainer = {
  id: string;
  name: string;
  state: string;
  failure: LabelParseFailure;
};

export type ManagedScan = {
  hostId: string;
  managed: ManagedContainer[];
  unusable: UnusableContainer[];
};

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

// all: a stopped container still holds its name and published port.
export async function scanManaged(
  client: Pick<DockerClient, "hostId" | "listContainers">,
): Promise<ManagedScan> {
  const containers = await client.listContainers({
    all: true,
    filters: { label: [MANAGED_FILTER] },
  });
  const rows = containers.map(classifyContainer);
  return {
    hostId: client.hostId,
    managed: rows.filter(isManagedRow),
    unusable: rows.filter((r): r is UnusableContainer => !isManagedRow(r)),
  };
}
