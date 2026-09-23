import type { Host, Visibility } from "@gangway/shared/domain";
import { verifyDaemon, type ContainerSummary } from "../docker/client.ts";
import { DockerGuardError } from "../docker/guard.ts";
import { LABEL, MANAGED_FILTER } from "../docker/labels.ts";
import { errorMessage } from "../errors.ts";
import { redactString } from "../logger.ts";
import type { ScannedContainer, ScannedLabels } from "./diff.ts";
import type { HostScan, ReconcilerDeps } from "./reconciler.ts";

const VISIBILITIES: readonly Visibility[] = ["public", "unlisted", "private"];

export function scanLabels(raw: Readonly<Record<string, string>>): ScannedLabels {
  const int = (v: string | undefined) =>
    v !== undefined && /^\d{1,5}$/.test(v) ? Number(v) : undefined;
  const vis = raw[LABEL.visibility];
  return {
    previewId: raw[LABEL.previewId] || undefined,
    hostname: raw[LABEL.hostname] || undefined,
    service: raw[LABEL.service] || undefined,
    containerPort: int(raw[LABEL.containerPort]),
    visibility: VISIBILITIES.includes(vis as Visibility) ? (vis as Visibility) : undefined,
    primary: booleanLabel(raw[LABEL.primary]),
    version: int(raw[LABEL.version]),
  };
}

function booleanLabel(v: string | undefined): boolean | undefined {
  if (v === "true") return true;
  return v === "false" ? false : undefined;
}

export function toScanned(
  c: ContainerSummary,
  host: Pick<Host, "id" | "upstream">,
): ScannedContainer {
  const labels = scanLabels(c.labels);
  const published = c.ports.find(
    (p) => p.protocol === "tcp" && p.hostPort !== null && p.containerPort === labels.containerPort,
  );
  return {
    id: c.id,
    hostId: host.id,
    upstreamHost: host.upstream.address,
    publishedPort: published?.hostPort ?? null,
    // paused and restarting containers still hold their port binding.
    state:
      c.state === "running" || c.state === "paused" || c.state === "restarting"
        ? "running"
        : "exited",
    labels,
  };
}

export async function scanHost(
  d: Pick<ReconcilerDeps, "ctx" | "clients" | "env">,
  host: Host,
): Promise<{ scan: HostScan; summaries: ContainerSummary[] }> {
  const { ctx, clients, env } = d;
  try {
    const client = clients.for(host);
    await verifyDaemon(client, host, env ?? process.env);
    const listed = await client.listContainers({
      all: true,
      filters: {
        label: [MANAGED_FILTER, `${LABEL.instance}=${ctx.instance}`, `${LABEL.env}=${ctx.env}`],
      },
    });
    // Re-check client-side in case the daemon ignored the filter.
    const ours = listed.filter(
      (c) =>
        c.labels[LABEL.managed] === "true" &&
        c.labels[LABEL.instance] === ctx.instance &&
        c.labels[LABEL.env] === ctx.env,
    );
    ctx.hosts.setState(host.id, "ready");
    return {
      scan: { hostId: host.id, reachable: true, error: null, containers: ours.length },
      summaries: ours,
    };
  } catch (e) {
    const message = redactString(errorMessage(e));
    ctx.hosts.setState(host.id, e instanceof DockerGuardError ? "error" : "unreachable", message);
    return {
      scan: { hostId: host.id, reachable: false, error: message, containers: 0 },
      summaries: [],
    };
  }
}
