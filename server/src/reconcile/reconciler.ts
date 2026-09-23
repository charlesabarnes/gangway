import type { Host, Preview } from "@gangway/shared/domain";
import type { ContainerSummary } from "../docker/client-types.ts";
import { LABEL } from "../docker/labels.ts";
import { entryPassword } from "../previews/password.ts";
import { releaseStack } from "../previews/destroy.ts";
import { isInRange } from "../routing/ports.ts";
import { SingleFlight } from "../util/async.ts";
import { parseDuration } from "../util/duration.ts";
import { isUlid } from "../util/ulid.ts";
import { diff, isMutating, type Action, type ScannedContainer } from "./diff.ts";
import type { ReconcileReport, ReconcilerDeps } from "./reconciler-types.ts";
import { coveredHostnames, isBusy, rescueInterrupted, wakeReturned } from "./recover.ts";
import { scanHost, toScanned } from "./scan.ts";

type Found = { summary: ContainerSummary; host: Host };
type Of<K extends Action["kind"]> = Extract<Action, { kind: K }>;

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

  async #pass(): Promise<ReconcileReport> {
    const { ctx, routes, logger } = this.#d;
    const at = ctx.now();
    const hosts = ctx.hosts.list();
    const hostsById = new Map(hosts.map((h) => [h.id, h]));

    const scanned = await Promise.all(hosts.map((h) => scanHost(this.#d, h)));
    const reachable = new Map(scanned.map((s) => [s.scan.hostId, s.scan.reachable]));
    const summaries = new Map<string, Found>();
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

    const changes = await this.#applyAll(actions, summaries, hostsById);
    const recovery = {
      ctx,
      routes,
      covered: coveredHostnames(actions),
      reachable,
      hosts: hostsById,
    };
    changes.push(...(await rescueInterrupted(recovery)));
    changes.push(...(await wakeReturned(recovery)));

    if (changes.length > 0) {
      logger.info("reconciled", { changes });
      ctx.bus.publish("reconcile.completed", { changes });
    }
    return { at, hosts: scanned.map((s) => s.scan), actions, changes };
  }

  async #applyAll(
    actions: readonly Action[],
    summaries: Map<string, Found>,
    hosts: Map<string, Host>,
  ): Promise<string[]> {
    const { logger } = this.#d;
    const changes: string[] = [];
    for (const a of actions) {
      try {
        const change = await this.#apply(a, summaries, hosts);
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
    return changes;
  }

  #busy(previewId: string): boolean {
    return isBusy(this.#d.ctx, previewId);
  }

  async #apply(
    a: Action,
    summaries: Map<string, Found>,
    hosts: Map<string, Host>,
  ): Promise<string | null> {
    if (!isMutating(a)) return null;

    switch (a.kind) {
      case "UpdateUpstream": {
        if (this.#busy(a.previewId)) return null;
        this.#d.ctx.table.updateUpstreamPort(a.hostname, a.to.port);
        return `${a.hostname}: upstream port ${a.from.port} -> ${a.to.port} (container was recreated by hand)`;
      }
      case "MarkAsleep":
        return this.#markAsleep(a);
      case "MarkFailed":
        return this.#markFailed(a, hosts);
      case "AdoptRoute":
        return this.#adopt(a, summaries.get(a.containerId), hosts.get(a.hostId));
      case "StopOrphan":
        return this.#stopOrphan(a, summaries.get(a.containerId));
    }
    return null;
  }

  #markAsleep(a: Of<"MarkAsleep">): string | null {
    const { ctx } = this.#d;
    const p = ctx.previews.get(a.previewId);
    if (!p || this.#busy(p.id)) return null;
    if (p.state !== "awake") return null;
    ctx.states.transition(p.id, "asleep");
    return `${p.project}: no running container; marked asleep`;
  }

  async #markFailed(a: Of<"MarkFailed">, hosts: Map<string, Host>): Promise<string | null> {
    const { ctx } = this.#d;
    const p = ctx.previews.get(a.previewId);
    if (!p || this.#busy(p.id) || p.state !== "building") return null;
    ctx.states.transition(p.id, "failed", a.error);
    ctx.logs.append(p.id, "system", `FAILED: ${a.error}`);
    const host = hosts.get(p.hostId);
    if (host) await releaseStack(ctx, p, host);
    return `${p.project}: ${a.error}`;
  }

  async #stopOrphan(a: Of<"StopOrphan">, found: Found | undefined): Promise<string | null> {
    if (!found) return null;
    // The scan may be stale: a deploy may have claimed this hostname since.
    const previewId = found.summary.labels[LABEL.previewId];
    if (previewId && this.#busy(previewId)) return null;
    if (a.hostname && this.#d.routes.get(a.hostname)?.previewId === previewId && previewId)
      return null;
    return this.#stop(found.host, found.summary, a.reason);
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
    a: Of<"AdoptRoute">,
    found: Found | undefined,
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
      preview = this.#adoptPreview(a, found.summary, host);
      if (!preview) return this.#stop(host, found.summary, "unadoptable");
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

  #adoptPreview(a: Of<"AdoptRoute">, summary: ContainerSummary, host: Host): Preview | undefined {
    const { ctx } = this.#d;
    const raw = summary.labels;
    const project = raw[LABEL.project] ?? raw["com.docker.compose.project"];
    if (!isUlid(a.previewId) || !project || ctx.previews.getByProject(project)) return undefined;
    const ttlText = ctx.policy.default().ttl;
    const ttl = ttlText === null ? null : parseDuration(ttlText);
    const preview = ctx.previews.create({
      id: a.previewId,
      project,
      hostId: host.id,
      state: "awake",
      source: { kind: "image", image: summary.image },
      visibility: a.visibility,
      ttlExpiresAt: ttl === null ? null : new Date(ctx.now() + ttl),
    });
    ctx.bus.publish(
      "preview.adopted",
      { project, reason: "container found with no database row" },
      preview.id,
    );
    return preview;
  }
}
