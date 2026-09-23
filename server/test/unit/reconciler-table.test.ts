import { describe, expect, test } from "bun:test";
import { destroy } from "../../src/previews/destroy.ts";
import { ACTOR } from "../helpers/preview-context.ts";
import { setupReconciler } from "../helpers/reconciler.ts";

describe("the reconciliation table", () => {
  test("a route with no container is marked asleep, and nothing is started", async () => {
    const s = setupReconciler();
    const { preview } = await s.deployed("hello");
    s.daemon.containers = [];
    const composedBefore = s.daemon.composed.length;
    const report = await s.reconciler.run();
    expect(report.changes).toEqual(["gw-default-hello: no running container; marked asleep"]);
    expect(s.previews.get(preview.id)!.state).toBe("asleep");
    expect(s.table.lookup("hello.preview.localhost")!.state).toBe("asleep");
    expect(s.daemon.composed.length).toBe(composedBefore);
    expect((await s.reconciler.run()).changes).toEqual([]);
  });

  test("a stopped container is the same case: it has released its port", async () => {
    const s = setupReconciler();
    const { preview } = await s.deployed("hello");
    s.daemon.containers[0]!.state = "exited";
    await s.reconciler.run();
    expect(s.previews.get(preview.id)!.state).toBe("asleep");
    expect(s.daemon.stopped).toEqual([]);
  });

  test("an asleep preview restarted by other hands is marked awake once it answers", async () => {
    const s = setupReconciler();
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
    expect((await s.reconciler.run()).changes).toEqual([]);
  });

  test("an asleep preview on an unreachable host stays asleep", async () => {
    const s = setupReconciler();
    const { preview } = await s.deployed("hello");
    s.daemon.containers[0]!.state = "exited";
    await s.reconciler.run();
    s.daemon.containers[0]!.state = "running";
    s.daemon.down = true;
    await s.reconciler.run();
    expect(s.previews.get(preview.id)!.state).toBe("asleep");
  });

  test("no route, container running: the route is rebuilt from labels", async () => {
    const s = setupReconciler();
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

  test("with the preview row gone, it comes back from the labels with a TTL", async () => {
    const s = setupReconciler();
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
    const s = setupReconciler();
    const { preview } = await s.deployed("hello");
    await destroy(s.ctx, preview.id, ACTOR); // the fake `down` leaves the container running
    const report = await s.reconciler.run();
    expect(s.daemon.stopped).toEqual(["c-hello.preview.localhost"]);
    expect(report.changes[0]).toContain("preview-destroyed");
    expect(s.table.size).toBe(0);
  });

  test("when a hand-made container moves the port, the route follows it", async () => {
    const s = setupReconciler();
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
    s: ReturnType<typeof setupReconciler>,
    state: "building" | "starting" | "destroying",
  ) => {
    const made = await s.deployed("hello");
    s.ctx.previews.setState(made.preview.id, state);
    s.table.setState(made.preview.id, state);
    return made;
  };

  test.each(["building", "starting"] as const)(
    "%s with the stack up and answering is marked awake",
    async (state) => {
      const s = setupReconciler();
      const { preview } = await interrupted(s, state);
      const report = await s.reconciler.run();
      expect(s.previews.get(preview.id)!.state).toBe("awake");
      expect(report.changes[0]).toContain("marked awake");
      expect(s.daemon.composed).not.toContain("down");
    },
  );

  test("starting with a container that does not answer fails and releases the stack", async () => {
    const s = setupReconciler();
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
    const s = setupReconciler();
    const { preview } = await interrupted(s, "building");
    s.daemon.containers = [];
    await s.reconciler.run();
    expect(s.previews.get(preview.id)!.state).toBe("failed");
    expect(s.previews.get(preview.id)!.error).toMatch(/did not survive a gangway restart/);
  });

  test("destroying: the teardown is finished, not abandoned", async () => {
    const s = setupReconciler();
    const { preview } = await interrupted(s, "destroying");
    const report = await s.reconciler.run();
    expect(s.previews.get(preview.id)!.state).toBe("destroyed");
    expect(s.table.size).toBe(0);
    expect(report.changes).toContain("gw-default-hello: interrupted teardown finished");
  });

  test("nothing is decided on a host that cannot be seen", async () => {
    const s = setupReconciler();
    const { preview } = await interrupted(s, "starting");
    s.daemon.down = true;
    await s.reconciler.run();
    expect(s.previews.get(preview.id)!.state).toBe("starting");
  });
});
