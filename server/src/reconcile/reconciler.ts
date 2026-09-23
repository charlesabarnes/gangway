import type { Host, Visibility } from "@gangway/shared/domain";
import type { RoutesRepo } from "../db/repos/routes.ts";
import { verifyDaemon, type ContainerSummary, type DockerClient } from "../docker/client.ts";
import { DockerGuardError } from "../docker/guard.ts";
import { LABEL, MANAGED_FILTER } from "../docker/labels.ts";
import { type Logger, redactString } from "../logger.ts";
import { entryPassword } from "../previews/password.ts";
import type { PreviewContext } from "../previews/context.ts";
import { releaseStack, teardown } from "../previews/destroy.ts";
import { isInRange } from "../routing/ports.ts";
import { SingleFlight } from "../util/async.ts";
import { parseDuration } from "../util/duration.ts";
import { isUlid } from "../util/ulid.ts";
import {
  diff,
  isMutating,
  type Action,
  type ScannedContainer,
  type ScannedLabels,
} from "./diff.ts";
import { errorMessage } from "../errors.ts";

export type ClientSource = {
  for(
    host: Pick<Host, "id" | "dockerHost">,
  ): Pick<DockerClient, "hostId" | "info" | "listContainers" | "stopContainer">;
};

export type ReconcilerDeps = {
  ctx: PreviewContext;
  routes: RoutesRepo;
  clients: ClientSource;
  logger: Logger;
  orphans?: "stop" | "report";
  env?: Readonly<Record<string, string | undefined>>;
};

export type HostScan = {
  hostId: string;
  reachable: boolean;
  error: string | null;
  containers: number;
};

export type ReconcileReport = {
  at: number;
  hosts: HostScan[];
  actions: Action[];
  changes: string[];
};

const VISIBILITIES: readonly Visibility[] = ["public", "unlisted", "private"];

export function scanLabels(raw: Readonly<Record<string, string>>): ScannedLabels {
  const int = (v: string | undefined) =>
    v !== undefined && /^\d{1,5}$/.test(v) ? Number(v) : undefined;
  const vis = raw[LABEL.visibility];
  const primary = raw[LABEL.primary];
  return {
    previewId: raw[LABEL.previewId] || undefined,
    hostname: raw[LABEL.hostname] || undefined,
    service: raw[LABEL.service] || undefined,
    containerPort: int(raw[LABEL.containerPort]),
    visibility: VISIBILITIES.includes(vis as Visibility) ? (vis as Visibility) : undefined,
    primary: primary === "true" ? true : primary === "false" ? false : undefined,
    version: int(raw[LABEL.version]),
  };
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

export class Reconciler {
  readonly #d: ReconcilerDeps;
  readonly #flight = new SingleFlight<ReconcileReport>();

  constructor(deps: ReconcilerDeps) {
    this.#d = deps;
  }

  // Concurrent callers share one pass; interleaved applies would corrupt state.
  run(): Promise<ReconcileReport> {
    return this.#flight.run("reconcile", () => this.#pass());
  }

  async #scanHost(host: Host): Promise<{ scan: HostScan; summaries: ContainerSummary[] }> {
    const { ctx, clients, env } = this.#d;
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

  async #pass(): Promise<ReconcileReport> {
    const { ctx, routes, logger } = this.#d;
    const at = ctx.now();
    const hosts = ctx.hosts.list();
    const hostsById = new Map(hosts.map((h) => [h.id, h]));

    const scanned = await Promise.all(hosts.map((h) => this.#scanHost(h)));
    const reachable = new Map(scanned.map((s) => [s.scan.hostId, s.scan.reachable]));
    const summaries = new Map<string, { summary: ContainerSummary; host: Host }>();
    const containers: ScannedContainer[] = [];
    scanned.forEach((s, i) => {
      for (const summary of s.summaries) {
        summaries.set(summary.id, { summary, host: hosts[i]! });
        containers.push(toScanned(summary, hosts[i]!));
      }
    });

    // Read after the scan: a concurrent deploy then shows as a route the in-flight guard covers.
    const actions = diff({
      dbRoutes: routes.all(),
      previews: ctx.previews.list({ includeDestroyed: true }),
      containers,
      hostReachable: reachable,
      now: at,
      liveBuilds: new Set(ctx.inflight.keys()),
    });

    const changes: string[] = [];
    for (const a of actions) {
      try {
        const change = await this.#apply(a, summaries, hostsById);
        if (change) changes.push(change);
      } catch (e) {
        logger.error("reconcile action failed", { action: a.kind, err: e });
      }
      if (a.kind === "LeaveAlone" && a.warn)
        logger.warn("reconcile anomaly", {
          reason: a.reason,
          hostname: a.hostname,
          containerId: a.containerId,
        });
    }

    const covered = new Set<string>();
    for (const a of actions) {
      if (
        a.kind === "UpdateUpstream" ||
        (a.kind === "LeaveAlone" && a.reason === "in-sync" && a.hostname)
      )
        covered.add(a.hostname!);
    }
    changes.push(...(await this.#rescueInterrupted(covered, reachable, hostsById)));
    changes.push(...(await this.#wakeReturned(covered, reachable, hostsById)));

    if (changes.length > 0) {
      logger.info("reconciled", { changes });
      ctx.bus.publish("reconcile.completed", { changes });
    }
    return { at, hosts: scanned.map((s) => s.scan), actions, changes };
  }

  #busy(previewId: string): boolean {
    return this.#d.ctx.inflight.has(previewId) || this.#d.ctx.teardowns.has(previewId);
  }

  async #apply(
    a: Action,
    summaries: Map<string, { summary: ContainerSummary; host: Host }>,
    hosts: Map<string, Host>,
  ): Promise<string | null> {
    const { ctx, routes } = this.#d;
    if (!isMutating(a)) return null;

    switch (a.kind) {
      case "UpdateUpstream": {
        if (this.#busy(a.previewId)) return null;
        ctx.table.updateUpstreamPort(a.hostname, a.to.port);
        return `${a.hostname}: upstream port ${a.from.port} -> ${a.to.port} (container was recreated by hand)`;
      }

      case "MarkAsleep": {
        const p = ctx.previews.get(a.previewId);
        if (!p || this.#busy(p.id)) return null;
        if (p.state !== "awake") return null;
        ctx.states.transition(p.id, "asleep");
        return `${p.project}: no running container; marked asleep`;
      }

      case "MarkFailed": {
        const p = ctx.previews.get(a.previewId);
        if (!p || this.#busy(p.id) || p.state !== "building") return null;
        ctx.states.transition(p.id, "failed", a.error);
        ctx.logs.append(p.id, "system", `FAILED: ${a.error}`);
        const host = hosts.get(p.hostId);
        if (host) await releaseStack(ctx, p, host);
        return `${p.project}: ${a.error}`;
      }

      case "AdoptRoute":
        return this.#adopt(a, summaries.get(a.containerId), hosts.get(a.hostId));

      case "StopOrphan": {
        const found = summaries.get(a.containerId);
        if (!found) return null;
        // The scan may be stale: a deploy may have claimed this hostname since.
        const previewId = found.summary.labels[LABEL.previewId];
        if (previewId && this.#busy(previewId)) return null;
        if (a.hostname && routes.get(a.hostname)?.previewId === previewId && previewId) return null;
        return this.#stop(found.host, found.summary, a.reason);
      }
    }
    return null;
  }

  async #stop(host: Host, c: ContainerSummary, reason: string): Promise<string> {
    const name = c.names[0] ?? c.id.slice(0, 12);
    if ((this.#d.orphans ?? "stop") === "report") {
      return `WOULD stop orphan ${name} on ${host.id} (${reason}) -- orphans=report`;
    }
    await this.#d.clients.for(host).stopContainer(c.id);
    return `stopped orphan ${name} on ${host.id} (${reason})`;
  }

  async #adopt(
    a: Extract<Action, { kind: "AdoptRoute" }>,
    found: { summary: ContainerSummary; host: Host } | undefined,
    host: Host | undefined,
  ): Promise<string | null> {
    const { ctx, logger } = this.#d;
    if (!found || !host || this.#busy(a.previewId)) return null;
    const raw = found.summary.labels;

    let preview = ctx.previews.get(a.previewId);
    if (preview && (preview.state === "destroyed" || preview.state === "destroying")) {
      return this.#stop(host, found.summary, "preview-destroyed");
    }

    if (!preview) {
      const project = raw[LABEL.project] ?? raw["com.docker.compose.project"];
      if (!isUlid(a.previewId) || !project || ctx.previews.getByProject(project)) {
        return this.#stop(host, found.summary, "unadoptable");
      }
      const ttlText = ctx.policy.default().ttl;
      const ttl = ttlText === null ? null : parseDuration(ttlText);
      preview = ctx.previews.create({
        id: a.previewId,
        project,
        hostId: host.id,
        state: "awake",
        source: { kind: "image", image: found.summary.image },
        visibility: a.visibility,
        ttlExpiresAt: ttl === null ? null : new Date(ctx.now() + ttl),
      });
      ctx.bus.publish(
        "preview.adopted",
        { project, reason: "container found with no database row" },
        preview.id,
      );
    }

    if (!isInRange(a.upstream.port, host.ports)) {
      logger.warn("adopting a route whose port is outside the host's pool", {
        hostname: a.hostname,
        port: a.upstream.port,
      });
    }
    ctx.table.apply({
      route: {
        hostname: a.hostname,
        previewId: a.previewId,
        service: a.service,
        containerPort: a.containerPort,
        upstream: a.upstream,
        primary: a.primary,
        createdAt: new Date(raw[LABEL.createdAt] ?? ctx.now()),
      },
      hostId: preview.hostId,
      project: preview.project,
      visibility: preview.visibility,
      state: preview.state,
      password: entryPassword(ctx.previews.passwordOf(preview.id)),
      passwordLogin: preview.passwordLogin,
    });
    return `${a.hostname}: route rebuilt from container labels`;
  }

  async #rescueInterrupted(
    covered: ReadonlySet<string>,
    reachable: Map<string, boolean>,
    hosts: Map<string, Host>,
  ): Promise<string[]> {
    const { ctx, routes } = this.#d;

    const out: string[] = [];
    for (const p of ctx.previews.list({ state: ["building", "starting", "destroying"] })) {
      const host = hosts.get(p.hostId);
      if (!host || !reachable.get(p.hostId) || this.#busy(p.id)) continue;

      if (p.state === "destroying") {
        ctx.logs.append(p.id, "system", "resuming a teardown interrupted by a restart");
        const done = await teardown(ctx, p, host).then(
          () => true,
          () => false,
        );
        out.push(`${p.project}: interrupted teardown ${done ? "finished" : "failed again"}`);
        continue;
      }

      const mine = routes.forPreview(p.id);
      const allUp = mine.length > 0 && mine.every((r) => covered.has(r.hostname));
      const answering =
        allUp && (await Promise.all(mine.map((r) => ctx.probe(r, host)))).every(Boolean);
      if (this.#busy(p.id) || ctx.previews.get(p.id)?.state !== p.state) continue;

      if (answering) {
        if (p.state === "building") ctx.states.transition(p.id, "starting");
        ctx.states.transition(p.id, "awake");
        ctx.logs.append(
          p.id,
          "system",
          "awake (the stack came up; the restart only interrupted the bookkeeping)",
        );
        out.push(
          `${p.project}: interrupted while ${p.state}, but the stack is up and answering; marked awake`,
        );
      } else {
        const error = `interrupted by a server restart while ${p.state}`;
        ctx.states.transition(p.id, "failed", error);
        ctx.logs.append(p.id, "system", `FAILED: ${error}`);
        const released = await releaseStack(ctx, p, host);
        out.push(`${p.project}: ${error}${released ? "; stack released" : ""}`);
      }
    }
    return out;
  }

  async #wakeReturned(
    covered: ReadonlySet<string>,
    reachable: Map<string, boolean>,
    hosts: Map<string, Host>,
  ): Promise<string[]> {
    const { ctx, routes } = this.#d;
    const out: string[] = [];
    for (const p of ctx.previews.list({ state: ["asleep"] })) {
      const host = hosts.get(p.hostId);
      if (!host || !reachable.get(p.hostId) || this.#busy(p.id)) continue;
      const mine = routes.forPreview(p.id);
      if (mine.length === 0 || !mine.every((r) => covered.has(r.hostname))) continue;
      const answering = (await Promise.all(mine.map((r) => ctx.probe(r, host)))).every(Boolean);
      if (!answering || this.#busy(p.id) || ctx.previews.get(p.id)?.state !== "asleep") continue;
      ctx.states.transition(p.id, "starting");
      ctx.states.transition(p.id, "awake");
      ctx.logs.append(
        p.id,
        "system",
        "awake (its containers were started outside gangway and are answering)",
      );
      out.push(`${p.project}: asleep, but its containers are running and answering; marked awake`);
    }
    return out;
  }
}
