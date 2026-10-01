/**
 * gangway against a real Docker engine and Compose: what the fakes in unit/ cannot prove.
 * Runs only with GANGWAY_REQUIRE_DOCKER=1, on a Linux host where gangway and Docker share 127.0.0.1.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, type Running } from "../../src/boot.ts";
import { loadConfig } from "../../src/config.ts";
import { client } from "../helpers/fake-daemon.ts";
import { freePort } from "../helpers/free-port.ts";
import { Logger } from "../../src/logger.ts";
import { tarball } from "../helpers/runtimes-fixtures.ts";

const enabled = process.env["GANGWAY_REQUIRE_DOCKER"] === "1";
const API = "api.preview.localhost";
const INSTANCE = `it${Date.now().toString(36)}`;
const SECRET = `gw-it-secret-${crypto.randomUUID()}`;
const PORTS = { start: 31700, end: 31719 };

/** A busybox web server on 8080; single-service, so it joins the shared network. */
const httpd = (extra = "") => `services:
  web:
    image: busybox:1.36
    command: ["sh", "-c", "echo ok > /tmp/index.html && exec httpd -f -p 8080 -h /tmp"]
    x-gangway: { expose: true, port: 8080 }
${extra}`;

async function docker(...args: string[]) {
  const p = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

const lines = (s: string) => s.split("\n").filter((l) => l !== "");
const ours = (kind: "ps" | "network" | "volume") =>
  docker(
    ...(kind === "ps" ? ["ps", "-a"] : [kind, "ls"]),
    "-q",
    "--filter",
    `label=gangway.instance=${INSTANCE}`,
  ).then((r) => lines(r.stdout));

let running: Running | undefined;
// Not tempDir(): its cleanup runs after each test, and this boot serves them all.
const stateDir = mkdtempSync(join(tmpdir(), "gangway-it-"));
let call: ReturnType<typeof client>;

type Deployed = { status: number; id: string; state: string; text: string };

const trace = (line: string) => process.stderr.write(`${line}\n`);
let deploys = 0;

async function deploy(files: Record<string, string>): Promise<Deployed> {
  const name = `it-${++deploys}`;
  trace(`deploying ${name}`);
  const query = `wait=true&visibility=public&runtime=own&name=${name}`;
  const res = await call(API, `/v1/previews?${query}`, {
    method: "POST",
    headers: { "content-type": "application/gzip" },
    body: await tarball(files),
  });
  const body = (await res.json()) as { preview?: { id: string; state: string } };
  const id = body.preview?.id ?? "";
  const logs = id ? await (await call(API, `/v1/previews/${id}/logs`)).text() : "";
  trace(`${name}: ${res.status} ${body.preview?.state ?? ""}\n${logs.slice(-6000)}`);
  return {
    status: res.status,
    id,
    state: body.preview?.state ?? "",
    text: JSON.stringify(body) + logs,
  };
}

/** The whole answer and log on failure, not just the state. */
const expectAwake = (...ds: Deployed[]) => {
  for (const d of ds) {
    expect({ state: d.state, text: d.text }).toMatchObject({ state: "awake" });
  }
};

async function containerOf(previewId: string) {
  const ids = lines(
    (await docker("ps", "-q", "--filter", `label=gangway.preview_id=${previewId}`)).stdout,
  );
  expect(ids).toHaveLength(1);
  return ids[0]!;
}

const ipOf = async (container: string) =>
  (
    await docker(
      "inspect",
      "--format",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
      container,
    )
  ).stdout.split(" ")[0]!;

const fetchFrom = (container: string, url: string) =>
  docker("exec", container, "wget", "-T", "3", "-qO-", url);

describe.skipIf(!enabled)("against real Docker", () => {
  beforeAll(async () => {
    const config = loadConfig(
      {
        GANGWAY_STATE_DIR: stateDir,
        GANGWAY_INSTANCE: INSTANCE,
        GANGWAY_LISTEN_ADDRESS: "127.0.0.1",
        GANGWAY_LISTEN_PORT: String(await freePort()),
        GANGWAY_LISTEN_HTTP_PORT: "",
        GANGWAY_ADMIN_TOKEN: "gw_it_admin_token_0123456789abcdef",
      },
      { hosts: [{ portRangeStart: PORTS.start, portRangeEnd: PORTS.end }] },
    );
    config.publicPort = config.listenPort;
    // Warnings and errors go to the job log: they are what explains a failed deploy here.
    running = await boot(config, { announce: () => {}, logger: new Logger("warn") });
    call = client(running);
    const set = await call(API, "/v1/secrets", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ set: { GW_IT_TOKEN: SECRET } }),
    });
    expect(set.status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await running?.stop();
    rmSync(stateDir, { recursive: true, force: true });
    // Whatever a failed test left behind; only this run's instance, never anything else.
    for (const c of await ours("ps")) {
      await docker("rm", "-f", "-v", c);
    }
    for (const v of await ours("volume")) {
      await docker("volume", "rm", "-f", v);
    }
    for (const n of await ours("network")) {
      await docker("network", "rm", n);
    }
    const images = lines(
      (await docker("images", "-q", "--filter", `reference=gw-${INSTANCE}-*`)).stdout,
    );
    if (images.length > 0) {
      await docker("rmi", "-f", ...images);
    }
  }, 120_000);

  test("two previews on the shared network cannot reach each other", async () => {
    const a = await deploy({ "compose.yaml": httpd() });
    const b = await deploy({ "compose.yaml": httpd() });
    expectAwake(a, b);

    const net = await docker("network", "inspect", `gw-${INSTANCE}-previews`);
    expect(net.code).toBe(0);

    const [ca, cb] = [await containerOf(a.id), await containerOf(b.id)];
    // The sanity check first: the request itself works, so a failure below is the network.
    expect((await fetchFrom(ca, "http://127.0.0.1:8080/")).stdout).toBe("ok");
    const ip = await ipOf(cb);
    trace(`from ${ca} to ${ip}`);
    const across = await fetchFrom(ca, `http://${ip}:8080/`);
    trace(`across: ${across.code} ${across.stderr}`);
    expect(across.code).not.toBe(0);
  }, 180_000);

  test("files compose would read outside the upload are refused, nested or not", async () => {
    const nested = await deploy({
      "compose.yaml": "include: [sub/inc.yaml]\n",
      "sub/inc.yaml": httpd("    env_file: ../../../../../etc/hostname\n"),
    });
    expect(nested.state).not.toBe("awake");
    expect(nested.text).toContain("outside the uploaded source");

    const extended = await deploy({
      "compose.yaml":
        "services:\n  web:\n    extends: { file: base.yaml, service: web }\n    x-gangway: { expose: true, port: 8080 }\n",
      "base.yaml": httpd("    label_file: /etc/hostname\n"),
    });
    expect(extended.state).not.toBe("awake");
    expect(extended.text).toContain("outside the uploaded source");
  }, 180_000);

  test("files inside the upload still work through include, extends and env_file", async () => {
    const ok = await deploy({
      "compose.yaml": "include: [sub/inc.yaml]\n",
      "sub/inc.yaml": "services:\n  web:\n    extends: { file: base.yaml, service: base }\n",
      "sub/base.yaml": httpd("    env_file: web.env\n").replace("  web:", "  base:"),
      "sub/web.env": "GREETING=hello\n",
    });
    expectAwake(ok);
    expect((await docker("exec", await containerOf(ok.id), "env")).stdout).toContain(
      "GREETING=hello",
    );
  }, 240_000);

  test("a secret reaches the running container but never a build", async () => {
    const baked = await deploy({
      "compose.yaml": `services:\n  web:\n    build:\n      context: .\n      args: { TOKEN: "\${GW_IT_TOKEN}" }\n    x-gangway: { expose: true, port: 8080 }\n`,
      Dockerfile: "FROM busybox:1.36\nARG TOKEN\nRUN echo $TOKEN > /token\n",
    });
    expect(baked.state).not.toBe("awake");
    expect(baked.text).toContain("build uses the secret GW_IT_TOKEN");
    expect(baked.text).not.toContain(SECRET);

    const runtime = await deploy({
      "compose.yaml": `services:\n  web:\n    build: .\n    command: ["sh", "-c", "echo ok > /tmp/index.html && exec httpd -f -p 8080 -h /tmp"]\n    environment: { TOKEN: "\${GW_IT_TOKEN}" }\n    x-gangway: { expose: true, port: 8080 }\n`,
      Dockerfile: "FROM busybox:1.36\n",
    });
    expectAwake(runtime);
    const c = await containerOf(runtime.id);
    expect((await docker("exec", c, "env")).stdout).toContain(`TOKEN=${SECRET}`);
    const image = (await docker("inspect", "--format", "{{.Image}}", c)).stdout;
    const history = await docker("history", "--no-trunc", image);
    expect(history.stdout).not.toContain(SECRET);
  }, 240_000);

  test("destroying every preview leaves no container or volume behind", async () => {
    const list = (await (await call(API, "/v1/previews")).json()) as {
      previews: { id: string; state: string }[];
    };
    for (const p of list.previews.filter((x) => x.state !== "destroyed")) {
      const res = await call(API, `/v1/previews/${p.id}`, { method: "DELETE" });
      expect(res.status).toBe(200);
    }
    expect(await ours("ps")).toEqual([]);
    expect(await ours("volume")).toEqual([]);
    // The shared network outlives its previews; every per-project network goes with its own.
    const left = await docker(
      "network",
      "ls",
      "--format",
      "{{.Name}}",
      "--filter",
      `label=gangway.instance=${INSTANCE}`,
    );
    expect(lines(left.stdout).filter((n) => n !== `gw-${INSTANCE}-previews`)).toEqual([]);
  }, 180_000);
});
