import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Route } from "@gangway/shared/domain";
import { staticTokenVerifier, type Actor } from "../../src/auth/actor.ts";
import { HostConfigSchema } from "../../src/config.ts";
import { migrate } from "../../src/db/migrate.ts";
import { Audit } from "../../src/audit/audit.ts";
import {
  AuditRepo,
  BuildsRepo,
  EventsRepo,
  HostsRepo,
  PreviewsRepo,
  RoutesRepo,
} from "../../src/db/repos/index.ts";
import { openDatabase } from "../../src/db/sqlite.ts";
import type { ContainerSummary, DockerInfo, ListOptions } from "../../src/docker/client-types.ts";
import type { ComposeEvent, ComposeResult } from "../../src/docker/compose.ts";
import { containerLabels } from "../../src/docker/labels.ts";
import type { ComposeRunner } from "../../src/docker/runner.ts";
import { EventBus } from "../../src/events/bus.ts";
import { seedHosts } from "../../src/hosts/seed.ts";
import { Logger } from "../../src/logger.ts";
import type { PreviewContext } from "../../src/previews/context.ts";
import { deploy } from "../../src/previews/deploy.ts";
import { fixedPolicy } from "../../src/previews/policy.ts";
import { destroy } from "../../src/previews/destroy.ts";
import { PreviewLogs } from "../../src/previews/logs.ts";
import { Workdirs } from "../../src/previews/source/workdir.ts";
import { PreviewStates } from "../../src/previews/state.ts";
import { Reconciler } from "../../src/reconcile/reconciler.ts";
import { scanLabels, toScanned } from "../../src/reconcile/scan.ts";
import { RouteTable } from "../../src/routing/table.ts";

const MIGRATIONS = join(import.meta.dir, "../../migrations");
const ACTOR = staticTokenVerifier("x")("x") as Actor;
const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const REMOTE_HOST: DockerInfo = {
  Name: "Docker-Host",
  OperatingSystem: "Debian GNU/Linux 12 (bookworm)",
};

function setup(o: { orphans?: "stop" | "report"; hangUp?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gangway-reconcile-"));
  tmps.push(dir);
  const { db } = openDatabase({ path: join(dir, "g.db") });
  migrate(db, MIGRATIONS);
  const hosts = new HostsRepo(db);
  seedHosts([HostConfigSchema.parse({ expectName: "Docker-Host" })], hosts);
  const previews = new PreviewsRepo(db);
  const routes = new RoutesRepo(db);
  const table = new RouteTable(routes);
  const bus = new EventBus(new EventsRepo(db));

  /** The fake daemon. Tests mutate these directly. */
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
    async *stream(argv, _h, opt): AsyncGenerator<ComposeEvent> {
      daemon.composed.push("up");
      if (o.hangUp)
        await new Promise<void>((r) => opt.signal?.addEventListener("abort", () => r()));
      opt.signal?.throwIfAborted();
      yield { type: "exit", code: 0, signal: null };
      void argv;
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
    logger: new Logger("error", {}, () => {}),
    timings: { startTimeoutMs: 200, probeTimeoutMs: 200, pollIntervalMs: 5 },
    now: Date.now,
    inflight: new Map(),
    teardowns: new Set(),
    builds: new BuildsRepo(db),
    audit: new Audit(new AuditRepo(db), new Logger("error", {}, () => {})),
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

describe("a quiet pass", () => {
  test("route and container agree: nothing changes, nothing is published, the host is ready", async () => {
    const s = setup();
    await s.deployed("hello");
    const before = s.eventTypes().length;
    const report = await s.reconciler.run();
    expect(report.changes).toEqual([]);
    expect(report.hosts).toEqual([
      { hostId: "local", reachable: true, error: null, containers: 1 },
    ]);
    expect(report.actions.map((a) => a.kind === "LeaveAlone" && a.reason)).toEqual(["in-sync"]);
    expect(s.eventTypes().length).toBe(before);
    expect(s.hosts.get("local")!.state).toBe("ready");
  });

  test("concurrent callers share one pass", async () => {
    const s = setup();
    const [a, b] = await Promise.all([s.reconciler.run(), s.reconciler.run()]);
    expect(a).toBe(b);
    expect(s.daemon.lists.length).toBe(1);
  });
});

describe("rule 1: provably ours, or not at all", () => {
  test("the daemon is asked only for THIS instance and env", async () => {
    const s = setup();
    await s.reconciler.run();
    expect(s.daemon.lists[0]).toEqual({
      all: true,
      filters: { label: ["gangway.managed=true", "gangway.instance=default", "gangway.env=test"] },
    });
  });

  test("another installation's container is never stopped, even if the daemon hands it to us, even with garbage labels", async () => {
    const s = setup();
    const { route, preview } = await s.deployed("hello");
    const foreign = s.containerFor(
      { ...route, hostname: "theirs.preview.localhost" },
      preview.project,
      { id: "c-foreign", instance: "someone-else" },
    );
    delete foreign.labels["gangway.service"]; // incomplete: would be a textbook StopOrphan
    const anonymous = s.containerFor(
      { ...route, hostname: "anon.preview.localhost" },
      preview.project,
      { id: "c-anon" },
    );
    delete anonymous.labels["gangway.instance"];
    s.daemon.containers.push(foreign, anonymous);
    const report = await s.reconciler.run();
    expect(s.daemon.stopped).toEqual([]);
    expect(report.hosts[0]!.containers).toBe(1);
  });

  test("OUR container with incomplete labels is an orphan holding a port: stopped", async () => {
    const s = setup();
    const { route, preview } = await s.deployed("hello");
    const orphan = s.containerFor(
      { ...route, hostname: "orphan.preview.localhost", previewId: "01J0000000000000000000000Z" },
      preview.project,
      { id: "c-orphan", hostPort: 31050 },
    );
    delete orphan.labels["gangway.service"];
    s.daemon.containers.push(orphan);
    const report = await s.reconciler.run();
    expect(s.daemon.stopped).toEqual(["c-orphan"]);
    expect(report.changes).toEqual([
      "stopped orphan gw-default-hello-web-1 on local (incomplete-labels)",
    ]);
    expect(s.eventTypes().at(-1)).toBe("reconcile.completed");
  });

  test("orphans=report names what it would stop, and stops nothing", async () => {
    const s = setup({ orphans: "report" });
    const { route, preview } = await s.deployed("hello");
    const orphan = s.containerFor(
      { ...route, hostname: "orphan.preview.localhost" },
      preview.project,
      { id: "c-orphan" },
    );
    delete orphan.labels["gangway.hostname"];
    s.daemon.containers.push(orphan);
    const report = await s.reconciler.run();
    expect(s.daemon.stopped).toEqual([]);
    expect(report.changes[0]).toMatch(/^WOULD stop orphan/);
  });
});

describe("rule 2: an unreachable host is not an empty host", () => {
  test("the tunnel drops: nothing is decided. It comes back: the host is ready again", async () => {
    const s = setup();
    const { preview } = await s.deployed("hello");
    s.daemon.down = true;
    const report = await s.reconciler.run();
    expect(report.changes).toEqual([]);
    expect(report.actions.filter((a) => a.kind !== "LeaveAlone")).toEqual([]);
    expect(s.previews.get(preview.id)!.state).toBe("awake");
    expect(s.table.size).toBe(1);
    expect(s.hosts.get("local")).toMatchObject({
      state: "unreachable",
      lastError: expect.stringContaining("ECONNREFUSED"),
    });

    s.daemon.down = false;
    await s.reconciler.run();
    expect(s.hosts.get("local")).toMatchObject({ state: "ready", lastError: null });
    expect(s.previews.get(preview.id)!.state).toBe("awake");
  });

  test("the WRONG daemon is an error, not a blip: never listed, never touched", async () => {
    const s = setup();
    const { preview } = await s.deployed("hello");
    s.daemon.containers = []; // a wrong daemon would indeed have none of ours
    s.daemon.info = { Name: "docker-desktop", OperatingSystem: "Docker Desktop" };
    const report = await s.reconciler.run();
    expect(s.daemon.lists).toEqual([]);
    expect(report.changes).toEqual([]);
    expect(s.previews.get(preview.id)!.state).toBe("awake");
    expect(s.hosts.get("local")).toMatchObject({
      state: "error",
      lastError: expect.stringContaining("Docker Desktop"),
    });
  });
});

describe("rule 3: work in flight is untouchable", () => {
  test("a deploy in `starting` has a route and no container yet. That is not a discrepancy", async () => {
    const s = setup({ hangUp: true });
    const res = await deploy(s.ctx, {
      actor: ACTOR,
      name: "slow",
      visibility: "public",
      source: { kind: "image", image: "x", port: 80 },
    });
    await Bun.sleep(20);
    expect(s.previews.get(res.preview.id)!.state).toBe("starting");
    const report = await s.reconciler.run();
    expect(report.changes).toEqual([]);
    expect(s.previews.get(res.preview.id)!.state).toBe("starting");
    await destroy(s.ctx, res.preview.id, ACTOR);
  });
});

describe("the reconciliation table", () => {
  test("route exists, no container: marked asleep -- and NOTHING is started", async () => {
    const s = setup();
    const { preview } = await s.deployed("hello");
    s.daemon.containers = [];
    const composedBefore = s.daemon.composed.length;
    const report = await s.reconciler.run();
    expect(report.changes).toEqual(["gw-default-hello: no running container; marked asleep"]);
    expect(s.previews.get(preview.id)!.state).toBe("asleep");
    expect(s.table.lookup("hello.preview.localhost")!.state).toBe("asleep");
    expect(s.daemon.composed.length).toBe(composedBefore);
    expect((await s.reconciler.run()).changes).toEqual([]); // idempotent
  });

  test("a stopped container is the same case: it has released its port", async () => {
    const s = setup();
    const { preview } = await s.deployed("hello");
    s.daemon.containers[0]!.state = "exited";
    await s.reconciler.run();
    expect(s.previews.get(preview.id)!.state).toBe("asleep");
    expect(s.daemon.stopped).toEqual([]);
  });

  test("asleep, and the container came back by other hands: marked awake once it ANSWERS -- and nothing is started", async () => {
    const s = setup();
    const { preview } = await s.deployed("hello");
    s.daemon.containers[0]!.state = "exited";
    await s.reconciler.run();
    expect(s.previews.get(preview.id)!.state).toBe("asleep");

    // `docker start`, but the app has not bound its port yet.
    s.daemon.containers[0]!.state = "running";
    s.daemon.probe = false;
    const composedBefore = s.daemon.composed.length;
    expect((await s.reconciler.run()).changes).toEqual([]);
    expect(s.previews.get(preview.id)!.state).toBe("asleep");

    s.daemon.probe = true;
    expect((await s.reconciler.run()).changes).toEqual([
      "gw-default-hello: asleep, but its containers are running and answering; marked awake",
    ]);
    expect(s.previews.get(preview.id)!.state).toBe("awake");
    expect(s.table.lookup("hello.preview.localhost")!.state).toBe("awake");
    expect(s.daemon.composed.length).toBe(composedBefore);
    expect(s.eventTypes().slice(-3)).toEqual([
      "preview.state",
      "preview.state",
      "reconcile.completed",
    ]);
    expect((await s.reconciler.run()).changes).toEqual([]); // idempotent
  });

  test("an asleep preview on an unreachable host stays asleep", async () => {
    const s = setup();
    const { preview } = await s.deployed("hello");
    s.daemon.containers[0]!.state = "exited";
    await s.reconciler.run();
    s.daemon.containers[0]!.state = "running";
    s.daemon.down = true;
    await s.reconciler.run();
    expect(s.previews.get(preview.id)!.state).toBe("asleep");
  });

  test("no route, container running: the route is rebuilt from labels", async () => {
    const s = setup();
    const { preview, route } = await s.deployed("hello");
    s.routes.delete(route.hostname);
    s.table.evict(route.hostname);
    const report = await s.reconciler.run();
    expect(report.changes).toEqual([
      "hello.preview.localhost: route rebuilt from container labels",
    ]);
    expect(s.table.lookup(route.hostname)).toMatchObject({
      previewId: preview.id,
      upstreamPort: route.upstream.port,
      state: "awake",
    });
    expect(s.routes.get(route.hostname)).toBeDefined();
  });

  test("SQLite is GONE: the preview row itself comes back from the labels, with a TTL", async () => {
    const s = setup();
    const { preview, route } = await s.deployed("hello");
    s.table.removePreview(preview.id);
    s.previews.delete(preview.id);
    await s.reconciler.run();
    const back = s.previews.get(preview.id)!;
    expect(back).toMatchObject({
      project: "gw-default-hello",
      state: "awake",
      visibility: "public",
      source: { kind: "image", image: "traefik/whoami:v1.10" },
    });
    expect(back.ttlExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(s.table.lookup(route.hostname)!.state).toBe("awake");
    expect(s.eventTypes()).toContain("preview.adopted");
  });

  test("a container that outlived its destroy is an orphan, not a route to restore", async () => {
    const s = setup();
    const { preview } = await s.deployed("hello");
    await destroy(s.ctx, preview.id, ACTOR); // fake `down` "succeeds"; the container lives on
    const report = await s.reconciler.run();
    expect(s.daemon.stopped).toEqual(["c-hello.preview.localhost"]);
    expect(report.changes[0]).toContain("preview-destroyed");
    expect(s.table.size).toBe(0);
  });

  test("the port moved (someone recreated the container by hand): the route follows it", async () => {
    const s = setup();
    const { route } = await s.deployed("hello");
    s.daemon.containers[0]!.ports[0]!.hostPort = 31077;
    const report = await s.reconciler.run();
    expect(report.changes[0]).toContain("31000 -> 31077");
    expect(s.table.lookup(route.hostname)!.upstreamPort).toBe(31077);
    expect(s.routes.get(route.hostname)!.upstream.port).toBe(31077);
  });
});

describe("interrupted by a restart", () => {
  const interrupted = async (
    s: ReturnType<typeof setup>,
    state: "building" | "starting" | "destroying",
  ) => {
    const made = await s.deployed("hello");
    // Rewind the row to where a dying process would have left it.
    s.ctx.previews.setState(made.preview.id, state);
    s.table.setState(made.preview.id, state);
    return made;
  };

  for (const state of ["building", "starting"] as const) {
    test(`${state}, but the stack is up and answering: only the bookkeeping was lost -> awake`, async () => {
      const s = setup();
      const { preview } = await interrupted(s, state);
      const report = await s.reconciler.run();
      expect(s.previews.get(preview.id)!.state).toBe("awake");
      expect(report.changes[0]).toContain("marked awake");
      expect(s.daemon.composed).not.toContain("down");
    });
  }

  test("starting, container up but NOT answering: failed, and the stack is released", async () => {
    const s = setup();
    const { preview } = await interrupted(s, "starting");
    s.daemon.probe = false;
    await s.reconciler.run();
    expect(s.previews.get(preview.id)).toMatchObject({
      state: "failed",
      error: "interrupted by a server restart while starting",
    });
    expect(s.daemon.composed.at(-1)).toBe("down");
    expect(s.table.size).toBe(1); // a failed preview keeps its URL, to show why
  });

  test("building, no container at all: failed", async () => {
    const s = setup();
    const { preview } = await interrupted(s, "building");
    s.daemon.containers = [];
    await s.reconciler.run();
    expect(s.previews.get(preview.id)!.state).toBe("failed");
    expect(s.previews.get(preview.id)!.error).toMatch(/did not survive a gangway restart/);
  });

  test("destroying: the teardown is finished, not abandoned", async () => {
    const s = setup();
    const { preview } = await interrupted(s, "destroying");
    const report = await s.reconciler.run();
    expect(s.previews.get(preview.id)!.state).toBe("destroyed");
    expect(s.table.size).toBe(0);
    expect(report.changes).toContain("gw-default-hello: interrupted teardown finished");
  });

  test("...but never on a host we cannot see: no evidence, no verdict", async () => {
    const s = setup();
    const { preview } = await interrupted(s, "starting");
    s.daemon.down = true;
    await s.reconciler.run();
    expect(s.previews.get(preview.id)!.state).toBe("starting");
  });
});

describe("scan mapping", () => {
  test("labels are read field by field; garbage becomes undefined, never a throw", () => {
    expect(
      scanLabels({
        "gangway.preview_id": "p",
        "gangway.container_port": "80",
        "gangway.primary": "yes",
        "gangway.visibility": "secret",
        "gangway.version": "2",
      }),
    ).toEqual({
      previewId: "p",
      hostname: undefined,
      service: undefined,
      containerPort: 80,
      visibility: undefined,
      primary: undefined,
      version: 2,
    });
    expect(
      scanLabels({ "gangway.container_port": "80; rm -rf /", "gangway.hostname": "" }),
    ).toMatchObject({ containerPort: undefined, hostname: undefined });
  });

  test("the published port is the one bound to the LABELLED container port, tcp only", () => {
    const host = {
      id: "local",
      upstream: { dial: "direct" as const, address: "10.0.0.5", proxy: null },
    };
    const c: ContainerSummary = {
      id: "c",
      names: ["n"],
      image: "i",
      state: "paused",
      status: "",
      createdAt: new Date(),
      labels: { "gangway.container_port": "80" },
      ports: [
        { ip: "0.0.0.0", containerPort: 9000, hostPort: 9000, protocol: "tcp" },
        { ip: "127.0.0.1", containerPort: 80, hostPort: 31005, protocol: "udp" },
        { ip: "127.0.0.1", containerPort: 80, hostPort: 31004, protocol: "tcp" },
      ],
    };
    expect(toScanned(c, host)).toMatchObject({
      publishedPort: 31004,
      upstreamHost: "10.0.0.5",
      state: "running",
    });
    expect(toScanned({ ...c, state: "created", ports: [] }, host)).toMatchObject({
      publishedPort: null,
      state: "exited",
    });
  });
});
