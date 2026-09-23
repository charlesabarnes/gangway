import { describe, expect, test } from "bun:test";
import type { ContainerSummary } from "../../src/docker/client-types.ts";
import { deploy } from "../../src/previews/deploy.ts";
import { destroy } from "../../src/previews/destroy.ts";
import { scanLabels, toScanned } from "../../src/reconcile/scan.ts";
import { ACTOR } from "../helpers/preview-context.ts";
import { setupReconciler } from "../helpers/reconciler.ts";

describe("a quiet pass", () => {
  test("when route and container agree, nothing changes and the host is ready", async () => {
    const s = setupReconciler();
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
    const s = setupReconciler();
    const [a, b] = await Promise.all([s.reconciler.run(), s.reconciler.run()]);
    expect(a).toBe(b);
    expect(s.daemon.lists.length).toBe(1);
  });
});

describe("rule 1: provably ours, or not at all", () => {
  test("the daemon is asked only for this instance and env", async () => {
    const s = setupReconciler();
    await s.reconciler.run();
    expect(s.daemon.lists[0]).toEqual({
      all: true,
      filters: { label: ["gangway.managed=true", "gangway.instance=default", "gangway.env=test"] },
    });
  });

  test("another installation's container is never stopped, whatever its labels", async () => {
    const s = setupReconciler();
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

  test("our container with incomplete labels is an orphan holding a port: stopped", async () => {
    const s = setupReconciler();
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
    const s = setupReconciler({ orphans: "report" });
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
  test("nothing is decided while the tunnel is down; the host is ready once it is back", async () => {
    const s = setupReconciler();
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

  test("the wrong daemon is an error, not a blip: never listed, never touched", async () => {
    const s = setupReconciler();
    const { preview } = await s.deployed("hello");
    s.daemon.containers = [];
    s.daemon.info = { Name: "docker-desktop", OperatingSystem: "Docker Desktop" };
    const report = await s.reconciler.run();
    expect(s.daemon.lists).toEqual([]);
    expect(report.changes).toEqual([]);
    expect(s.previews.get(preview.id)!.state).toBe("awake");
    expect(s.hosts.get("local")).toMatchObject({
      state: "error",
      lastError: expect.stringContaining("wrong daemon"),
    });
  });
});

describe("rule 3: work in flight is untouchable", () => {
  test("a starting deploy with a route and no container yet is not a discrepancy", async () => {
    const s = setupReconciler({ hangUp: true });
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

  test("the published port is the one bound to the labelled container port, tcp only", () => {
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
