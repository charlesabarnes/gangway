import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { deploy } from "../../src/previews/deploy.ts";
import { destroy } from "../../src/previews/destroy.ts";
import { canTransition } from "../../src/previews/state.ts";
import { setupScriptedDeploy } from "../helpers/deploy-script.ts";
import { ACTOR } from "../helpers/preview-context.ts";

describe("deploy: run failures leave a `failed` preview that explains itself", () => {
  test("a failed `up` salvages container logs and tears down the stack; the route stays", async () => {
    const s = setupScriptedDeploy({
      up: { code: 1, lines: ["Error response from daemon: port is already allocated"] },
    });
    const res = await deploy(s.ctx, s.input());
    const final = await res.done;
    expect(final).toMatchObject({ state: "failed", error: "compose up exited 1" });
    expect(s.calls.map((c) => c.cmd)).toEqual(["config", "up", "logs", "down"]);
    const down = s.calls.at(-1)!;
    expect(down.argv).not.toContain("--file");
    // A failed stack's containers go; its volumes (an add-on's data) stay until destroy.
    expect(down.argv.slice(-4)).toEqual(["down", "--remove-orphans", "--rmi", "local"]);
    const tail = s.logs.tail(res.preview.id).join("\n");
    expect(tail).toContain("port is already allocated");
    expect(tail).toContain("EADDRINUSE");
    expect(s.table.lookup("web-app.preview.localhost")!.state).toBe("failed");
  });

  test.each([
    [
      "crashed",
      { Service: "web", State: "exited", ExitCode: 137 },
      /^service "web" exited with code 137$/,
    ],
    [
      "unhealthy",
      { Service: "web", State: "running", Health: "unhealthy" },
      /^service "web" is unhealthy$/,
    ],
    [
      "never healthy",
      { Service: "web", State: "running", Health: "starting" },
      /timed out after .* waiting for web: starting/,
    ],
  ] as const)("a %s service fails the preview", async (_what, ps, error) => {
    const s = setupScriptedDeploy({ ps: [[ps]] });
    expect((await (await deploy(s.ctx, s.input())).done).error).toMatch(error);
  });

  test("healthy but never answering HTTP names the likely causes", async () => {
    const s = setupScriptedDeploy({ probe: [false] });
    expect((await (await deploy(s.ctx, s.input())).done).error).toMatch(
      /web:3000 never answered HTTP.*0\.0\.0\.0/,
    );
  });
});

describe("destroy", () => {
  test("a file-less down from an empty directory, then routes, state, logs", async () => {
    const s = setupScriptedDeploy();
    const res = await deploy(s.ctx, s.input());
    await res.done;
    const gone = await destroy(s.ctx, res.preview.id, ACTOR);
    expect(gone.state).toBe("destroyed");
    expect(gone.destroyedAt).not.toBeNull();
    const down = s.calls.find((c) => c.argv.includes("down"))!;
    expect(down.argv).toEqual([
      "docker",
      "compose",
      "--project-name",
      "gw-default-web-app",
      "down",
      "-v",
      "--remove-orphans",
      "--rmi",
      "local",
    ]);
    // Then anything still labelled with the project, which a kept volume would be.
    expect(s.calls.slice(-2).map((c) => c.argv)).toEqual([
      [
        "docker",
        "volume",
        "ls",
        "--quiet",
        "--filter",
        "label=com.docker.compose.project=gw-default-web-app",
      ],
      [
        "docker",
        "image",
        "ls",
        "--quiet",
        "--filter",
        "dangling=true",
        "--filter",
        "label=com.docker.compose.project=gw-default-web-app",
      ],
    ]);
    expect(down.cwd).toContain("gangway-down-");
    expect(existsSync(down.cwd)).toBe(false);
    expect(s.table.size).toBe(0);
    expect(s.logs.read(res.preview.id)).toEqual([]);
    expect(s.events().slice(-2)).toEqual(["preview.state:destroying", "preview.state:destroyed"]);
    await expect(destroy(s.ctx, res.preview.id, ACTOR)).rejects.toMatchObject({ status: 404 });
  });

  test.each([[{ code: 1, stderr: "cannot connect" }], ["throw"]] as const)(
    "if the daemon cannot confirm (%j), routes and ports stay claimed",
    async (down) => {
      const s = setupScriptedDeploy({ down });
      const res = await deploy(s.ctx, s.input());
      await res.done;
      await expect(destroy(s.ctx, res.preview.id, ACTOR)).rejects.toMatchObject({ status: 502 });
      expect(s.previews.get(res.preview.id)).toMatchObject({
        state: "failed",
        error: expect.stringContaining("destroy failed"),
      });
      expect(s.table.usedPorts("127.0.0.1")).toEqual(new Set([31000]));
    },
  );

  test("destroying a running deploy cancels it first, and it does not fight back", async () => {
    const s = setupScriptedDeploy({ up: { code: 0, hang: true } });
    const res = await deploy(s.ctx, s.input());
    await Bun.sleep(20);
    expect(s.previews.get(res.preview.id)!.state).toBe("starting");
    const gone = await destroy(s.ctx, res.preview.id, ACTOR);
    expect(gone.state).toBe("destroyed");
    await res.done;
    expect(s.previews.get(res.preview.id)!.state).toBe("destroyed");
    expect(s.calls.map((c) => c.cmd)).toEqual(["config", "up", "down"]);
  });

  test("a second destroy while the first is in flight is a 409", async () => {
    const s = setupScriptedDeploy();
    const res = await deploy(s.ctx, s.input());
    await res.done;
    const first = destroy(s.ctx, res.preview.id, ACTOR);
    await expect(destroy(s.ctx, res.preview.id, ACTOR)).rejects.toMatchObject({ status: 409 });
    await first;
  });
});

describe("the preview state machine", () => {
  test.each([
    ["building", "starting", true],
    ["destroying", "failed", true],
    ["failed", "destroying", true],
    ["destroyed", "building", false],
    ["destroying", "awake", false],
    ["building", "awake", false],
  ] as const)("%s -> %s allowed: %p", (from, to, allowed) => {
    expect(canTransition(from, to)).toBe(allowed);
  });
});
