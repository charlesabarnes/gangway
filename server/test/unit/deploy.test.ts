import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseLabels } from "../../src/docker/labels.ts";
import { deploy } from "../../src/previews/deploy.ts";
import { destroy } from "../../src/previews/destroy.ts";
import { setupScriptedDeploy } from "../helpers/deploy-script.ts";
import { ACTOR } from "../helpers/preview-context.ts";

describe("deploy: the happy path", () => {
  test("an image goes awake, with a URL known before any container exists", async () => {
    const { ctx, input, calls, events, dir, logs } = setupScriptedDeploy();
    const res = await deploy(ctx, input());

    expect(res.preview).toMatchObject({
      state: "building",
      project: "gw-default-web-app",
      hostId: "local",
      source: { kind: "image", image: "ghcr.io/acme/web-app:1.2" },
    });
    expect(res.urls).toEqual([
      { service: "web", url: "https://web-app.preview.localhost:8443/", primary: true },
    ]);
    expect(ctx.table.lookup("web-app.preview.localhost")).toMatchObject({
      state: "building",
      upstreamPort: 31000,
    });

    const final = await res.done;
    expect(final.state).toBe("awake");
    expect(ctx.table.lookup("web-app.preview.localhost")!.state).toBe("awake");
    expect(events()).toEqual(["preview.created", "preview.state:starting", "preview.state:awake"]);
    expect(calls.map((c) => c.cmd)).toEqual(["config", "up", "ps"]);
    // YAML output: `--format json` silently drops service-level x-gangway.
    expect(calls[0]!.argv).not.toContain("--format");
    expect(logs.tail(res.preview.id).join("\n")).toContain("Started");
    expect(ctx.inflight.size).toBe(0);
    expect(existsSync(join(dir, "work", res.preview.id))).toBe(false);
  });

  test("the route row exists before `compose up` runs, never after", async () => {
    const { ctx, input, calls } = setupScriptedDeploy();
    await (
      await deploy(ctx, input())
    ).done;
    expect(calls.find((c) => c.cmd === "config")!.routesAtCall).toBe(0);
    expect(calls.find((c) => c.cmd === "up")!.routesAtCall).toBe(1);
  });

  test("`up` runs only the generated stack file, under the real project name", async () => {
    const { ctx, input, calls } = setupScriptedDeploy();
    const res = await deploy(ctx, input());
    await res.done;
    const up = calls.find((c) => c.cmd === "up")!;
    expect(up.argv.slice(0, 4)).toEqual([
      "docker",
      "compose",
      "--project-name",
      "gw-default-web-app",
    ]);
    expect(
      up.argv.filter((_, i) => up.argv[i - 1] === "--file").map((f) => f.split("/").pop()),
    ).toEqual(["gangway.stack.yaml"]);
    expect(up.argv.slice(-4)).toEqual(["up", "-d", "--no-build", "--remove-orphans"]);
    const stack = JSON.parse(up.stack!);
    expect(stack.name).toBe("gw-default-web-app");
    expect(stack.services.web.ports).toEqual([
      { mode: "ingress", host_ip: "127.0.0.1", target: 3000, published: "31000", protocol: "tcp" },
    ]);
    expect("name" in stack.networks.default).toBe(false);
    expect(parseLabels(stack.services.web.labels)).toMatchObject({
      ok: true,
      labels: {
        previewId: res.preview.id,
        hostname: "web-app.preview.localhost",
        port: 31000,
        env: "test",
      },
    });
  });

  test("unlisted by default, with an unguessable hostname and the default ttl", async () => {
    const { ctx, input } = setupScriptedDeploy();
    const a = await deploy(ctx, input({ visibility: undefined, name: "Demo App" }));
    expect(a.urls[0]!.url).toMatch(/^https:\/\/demo-app-[a-z0-9]{10}\.preview\.localhost:8443\/$/);
    expect(a.preview.visibility).toBe("unlisted");
    expect(a.preview.ttlExpiresAt!.getTime() - a.preview.createdAt.getTime()).toBe(7 * 86_400_000);
    const b = await deploy(ctx, input({ name: "forever", ttl: null }));
    expect(b.preview.ttlExpiresAt).toBeNull();
    await Promise.all([a.done, b.done]);
  });

  test("waits out `starting` health and a port that is not answering yet", async () => {
    const { ctx, input, logs } = setupScriptedDeploy({
      ps: [
        [{ Service: "web", State: "running", Health: "starting" }],
        [{ Service: "web", State: "running", Health: "healthy" }],
      ],
      probe: [false, false, true],
    });
    const res = await deploy(ctx, input());
    expect((await res.done).state).toBe("awake");
    expect(logs.tail(res.preview.id).join("\n")).toContain("waiting for web: starting");
  });

  test("a one-shot sidecar that exited 0 does not hold the stack back", async () => {
    const { ctx, input } = setupScriptedDeploy({
      ps: [
        [
          { Service: "web", State: "running" },
          { Service: "migrate", State: "exited", ExitCode: 0 },
        ],
      ],
    });
    expect((await (await deploy(ctx, input())).done).state).toBe("awake");
  });
});

describe("deploy: planning failures leave nothing behind and are the caller's 4xx", () => {
  const nothingLeft = (s: ReturnType<typeof setupScriptedDeploy>) => {
    expect(s.previews.list({ includeDestroyed: true })).toEqual([]);
    expect(s.table.size).toBe(0);
    expect(s.calls.some((c) => c.cmd === "up")).toBe(false);
    expect(
      existsSync(join(s.dir, "work"))
        ? Bun.spawnSync(["ls", join(s.dir, "work")]).stdout.toString()
        : "",
    ).toBe("");
  };

  test("an invalid compose file", async () => {
    const s = setupScriptedDeploy({ config: () => "invalid" });
    await expect(deploy(s.ctx, s.input())).rejects.toMatchObject({
      status: 422,
      detail: { compose: expect.stringContaining("did not find expected key") },
    });
    nothingLeft(s);
  });

  test("a policy violation", async () => {
    const s = setupScriptedDeploy({
      config: () => ({
        services: {
          web: { image: "x", privileged: true, ports: [{ target: 80, protocol: "tcp" }] },
        },
      }),
    });
    await expect(deploy(s.ctx, s.input())).rejects.toMatchObject({
      status: 422,
      detail: { violations: ['service "web": privileged is not allowed'] },
    });
    nothingLeft(s);
  });

  test("reserved names, bad ttl, private visibility, unknown host", async () => {
    const s = setupScriptedDeploy();
    await expect(deploy(s.ctx, s.input({ name: "api" }))).rejects.toMatchObject({ status: 422 });
    await expect(deploy(s.ctx, s.input({ ttl: "soon" }))).rejects.toMatchObject({ status: 422 });
    s.ctx.privateAvailable = () => false;
    await expect(deploy(s.ctx, s.input({ visibility: "private" }))).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("switched off"),
    });
    s.ctx.privateAvailable = () => true;
    await expect(deploy(s.ctx, s.input({ hostId: "elsewhere" }))).rejects.toMatchObject({
      status: 422,
    });
    nothingLeft(s);
  });

  test("a private preview deploys, and its route carries the visibility the gate reads", async () => {
    const s = setupScriptedDeploy();
    const res = await deploy(s.ctx, s.input({ name: "secret", visibility: "private" }));
    expect((await res.done).visibility).toBe("private");
    expect(s.ctx.table.lookup("secret.preview.localhost")).toMatchObject({
      visibility: "private",
      previewId: res.preview.id,
    });
  });

  test("a live name is a 409; a destroyed one is reusable", async () => {
    const s = setupScriptedDeploy();
    const first = await deploy(s.ctx, s.input());
    await first.done;
    await expect(deploy(s.ctx, s.input())).rejects.toMatchObject({
      status: 409,
      detail: { previewId: first.preview.id },
    });
    await destroy(s.ctx, first.preview.id, ACTOR);
    const second = await deploy(s.ctx, s.input());
    expect(second.urls).toEqual(first.urls);
    expect((await second.done).state).toBe("awake");
    expect(s.previews.list({ includeDestroyed: true }).map((p) => p.id)).toEqual([
      second.preview.id,
    ]);
  });

  test("the port pool is finite, and says so", async () => {
    const s = setupScriptedDeploy();
    for (const name of ["a1", "a2", "a3"]) await (await deploy(s.ctx, s.input({ name }))).done;
    expect(s.table.usedPorts("127.0.0.1")).toEqual(new Set([31000, 31001, 31002]));
    await expect(deploy(s.ctx, s.input({ name: "a4" }))).rejects.toMatchObject({ status: 503 });
  });

  test("concurrent deploys never share a port", async () => {
    const s = setupScriptedDeploy();
    const all = await Promise.all(
      ["c1", "c2", "c3"].map((name) => deploy(s.ctx, s.input({ name }))),
    );
    await Promise.all(all.map((r) => r.done));
    expect(s.table.usedPorts("127.0.0.1").size).toBe(3);
  });
});
