import type { Route } from "@gangway/shared/domain";
import { Audit } from "../../src/audit/audit.ts";
import {
  AuditRepo,
  BuildsRepo,
  EventsRepo,
  PreviewsRepo,
  RoutesRepo,
} from "../../src/db/repos/index.ts";
import type { ContainerSummary, DockerInfo, ListOptions } from "../../src/docker/client-types.ts";
import type { ComposeEvent, ComposeResult } from "../../src/docker/compose.ts";
import { containerLabels } from "../../src/docker/labels.ts";
import type { ComposeRunner } from "../../src/docker/runner.ts";
import { EventBus } from "../../src/events/bus.ts";
import { Logger } from "../../src/logger.ts";
import type { PreviewContext } from "../../src/previews/context.ts";
import { deploy } from "../../src/previews/deploy.ts";
import { fixedPolicy } from "../../src/previews/policy.ts";
import { PreviewLogs } from "../../src/previews/logs.ts";
import { Workdirs } from "../../src/previews/source/workdir.ts";
import { PreviewStates } from "../../src/previews/state.ts";
import { Reconciler } from "../../src/reconcile/reconciler.ts";
import { RouteTable } from "../../src/routing/table.ts";
import { tempDb } from "./db.ts";
import { seededHosts } from "./hosts.ts";
import { silentLogger } from "./logger.ts";
import { ACTOR } from "./preview-context.ts";

const REMOTE_HOST: DockerInfo = {
  Name: "Docker-Host",
  OperatingSystem: "Debian GNU/Linux 12 (bookworm)",
};

/** A Reconciler over a real database and a fake daemon the test mutates directly. */
export function setupReconciler(o: { orphans?: "stop" | "report"; hangUp?: boolean } = {}) {
  const { db, dir } = tempDb();
  const hosts = seededHosts(db, { expectName: "Docker-Host" });
  const previews = new PreviewsRepo(db);
  const routes = new RoutesRepo(db);
  const table = new RouteTable(routes);
  const bus = new EventBus(new EventsRepo(db));

  const daemon = {
    containers: [] as ContainerSummary[],
    info: REMOTE_HOST,
    down: false,
    lists: [] as ListOptions[],
    stopped: [] as string[],
    composed: [] as string[],
    probe: true,
  };
  const clients = {
    for: () => ({
      hostId: "local",
      info: async () => {
        if (daemon.down) throw new Error("connect ECONNREFUSED 127.0.0.1:23750");
        return daemon.info;
      },
      listContainers: async (opts: ListOptions = {}) => {
        daemon.lists.push(opts);
        await Bun.sleep(5);
        return daemon.containers;
      },
      stopContainer: async (id: string) => {
        daemon.stopped.push(id);
      },
    }),
  };
  const compose: ComposeRunner = {
    async *stream(_argv, _h, opt): AsyncGenerator<ComposeEvent> {
      daemon.composed.push("up");
      if (o.hangUp)
        await new Promise<void>((r) => opt.signal?.addEventListener("abort", () => r()));
      opt.signal?.throwIfAborted();
      yield { type: "exit", code: 0, signal: null };
    },
    async capture(argv): Promise<ComposeResult> {
      const cmd = argv.find((a) => ["config", "ps", "down", "logs"].includes(a))!;
      daemon.composed.push(cmd);
      const stdout =
        cmd === "config"
          ? await Bun.file(argv[argv.indexOf("--file") + 1]!).text()
          : cmd === "ps"
            ? JSON.stringify({ Service: "web", State: "running" })
            : "";
      return { code: 0, stdout, stderr: "", signal: null };
    },
  };

  const ctx: PreviewContext = {
    instance: "default",
    env: "test",
    origin: { scheme: "https", port: 8443 },
    baseDomain: () => "preview.localhost",
    policy: fixedPolicy(),
    hosts,
    previews,
    table,
    bus,
    compose,
    logs: new PreviewLogs(dir),
    workdirs: new Workdirs(dir),
    states: new PreviewStates(previews, table, bus),
    probe: async () => daemon.probe,
    logger: silentLogger(),
    timings: { startTimeoutMs: 200, probeTimeoutMs: 200, pollIntervalMs: 5 },
    now: Date.now,
    inflight: new Map(),
    teardowns: new Set(),
    builds: new BuildsRepo(db),
    audit: new Audit(new AuditRepo(db), silentLogger()),
  };
  const lines: string[] = [];
  const reconciler = new Reconciler({
    ctx,
    routes,
    clients,
    logger: new Logger("info", {}, (l) => lines.push(l)),
    env: {},
    ...(o.orphans ? { orphans: o.orphans } : {}),
  });

  /** A container exactly as the deploy pipeline would have labelled it. */
  const containerFor = (
    route: Route,
    project: string,
    over: Partial<ContainerSummary> & { instance?: string; hostPort?: number } = {},
  ): ContainerSummary => ({
    id: `c-${route.hostname}`,
    names: [`${project}-${route.service}-1`],
    image: "traefik/whoami:v1.10",
    state: "running",
    status: "Up",
    createdAt: new Date(),
    labels: containerLabels(route, {
      instance: over.instance ?? "default",
      env: "test",
      project,
      hostId: "local",
      visibility: "public",
    }),
    ports: [
      {
        ip: "127.0.0.1",
        containerPort: route.containerPort,
        hostPort: over.hostPort ?? route.upstream.port,
        protocol: "tcp",
      },
    ],
    ...over,
  });

  const deployed = async (name: string) => {
    const res = await deploy(ctx, {
      actor: ACTOR,
      name,
      visibility: "public",
      source: { kind: "image", image: "traefik/whoami:v1.10", port: 80 },
    });
    const preview = await res.done;
    const route = routes.forPreview(preview.id)[0]!;
    daemon.containers.push(containerFor(route, preview.project));
    return { preview, route };
  };
  const eventTypes = () => new EventsRepo(db).since(0).map((e) => e.type);
  return {
    ctx,
    reconciler,
    daemon,
    routes,
    previews,
    table,
    hosts,
    containerFor,
    deployed,
    eventTypes,
    lines,
  };
}
