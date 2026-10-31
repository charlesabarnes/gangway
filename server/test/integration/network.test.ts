/**
 * What a preview on a restricted host can reach, against real Docker and nftables. Runs only with
 * GANGWAY_REQUIRE_DOCKER=1 on a Linux host where it may change nftables (CI's throwaway runner).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { boot, type Running } from "../../src/boot.ts";
import { loadConfig } from "../../src/config.ts";
import { EGRESS_TABLE } from "../../src/hosts/egress.ts";
import { Logger } from "../../src/logger.ts";
import { client } from "../helpers/fake-daemon.ts";
import { freePort } from "../helpers/free-port.ts";
import { tarball } from "../helpers/runtimes-fixtures.ts";

const enabled = process.env["GANGWAY_REQUIRE_DOCKER"] === "1";
const API = "api.preview.localhost";
const INSTANCE = `nt${Date.now().toString(36)}`;
const HELPER = process.env["GANGWAY_IT_HELPER_IMAGE"] ?? "gw-it-helper";

/** Two services, so each preview gets a network, and a bridge, of its own. */
const httpd = `services:
  web:
    image: busybox:1.36
    command: ["sh", "-c", "echo ok > /tmp/index.html && exec httpd -f -p 8080 -h /tmp"]
    x-gangway: { expose: true, port: 8080 }
  idle:
    image: busybox:1.36
    command: ["sleep", "3600"]
`;

async function docker(...args: string[]) {
  const p = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { code, stdout: stdout.trim() };
}

/** The machine's own address, as a pool host publishes on: not loopback, not a bridge. */
function hostAddress(): string {
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    const v4 = addrs?.find((a) => a.family === "IPv4" && !a.internal);
    if (v4 && !name.startsWith("docker") && !name.startsWith("br-") && !name.startsWith("veth")) {
      return v4.address;
    }
  }
  throw new Error("no address to publish on");
}

const ip = hostAddress();
const stateDir = mkdtempSync(join(tmpdir(), "gangway-nt-"));
let running: Running | undefined;
let call: ReturnType<typeof client>;
let deploys = 0;

async function deployed(): Promise<{ container: string; port: string }> {
  const res = await call(API, `/v1/previews?wait=true&visibility=public&name=nt-${++deploys}`, {
    method: "POST",
    headers: { "content-type": "application/gzip" },
    body: await tarball({ "compose.yaml": httpd }),
  });
  const body = (await res.json()) as { preview?: { id: string; state: string } };
  expect(body.preview?.state).toBe("awake");
  const id = body.preview?.id ?? "";
  const container = (
    await docker(
      "ps",
      "-q",
      "--filter",
      `label=gangway.preview_id=${id}`,
      "--filter",
      "label=com.docker.compose.service=web",
    )
  ).stdout;
  const port = (await docker("port", container, "8080/tcp")).stdout.split(":").at(-1) ?? "";
  return { container, port };
}

const reaches = async (container: string, url: string) =>
  (await docker("exec", container, "wget", "-T", "3", "-qO-", url)).code === 0;

describe.skipIf(!enabled)("a preview on a restricted host", () => {
  beforeAll(async () => {
    const config = loadConfig(
      {
        GANGWAY_STATE_DIR: stateDir,
        GANGWAY_INSTANCE: INSTANCE,
        GANGWAY_LISTEN_ADDRESS: "127.0.0.1",
        GANGWAY_LISTEN_PORT: String(await freePort()),
        GANGWAY_LISTEN_HTTP_PORT: "",
        GANGWAY_ADMIN_TOKEN: "gw_nt_admin_token_0123456789abcdef",
        GANGWAY_HELPER_IMAGE: HELPER,
      },
      {
        hosts: [
          {
            portRangeStart: 31720,
            portRangeEnd: 31739,
            publishBind: ip,
            upstreamAddress: ip,
            egress: "restricted",
          },
        ],
      },
    );
    config.publicPort = config.listenPort;
    running = await boot(config, { announce: () => {}, logger: new Logger("warn") });
    call = client(running);
  }, 60_000);

  afterAll(async () => {
    await running?.stop();
    rmSync(stateDir, { recursive: true, force: true });
    const left = (await docker("ps", "-aq", "--filter", `label=gangway.instance=${INSTANCE}`))
      .stdout;
    if (left) {
      await docker("rm", "-f", "-v", ...left.split("\n"));
    }
    const nets = (
      await docker("network", "ls", "-q", "--filter", `label=gangway.instance=${INSTANCE}`)
    ).stdout;
    if (nets) {
      await docker("network", "rm", ...nets.split("\n"));
    }
    const off = ["--rm", "--network", "host", "--cap-add", "NET_ADMIN", "--entrypoint", "nft"];
    await docker("run", ...off, HELPER, "delete", "table", "inet", EGRESS_TABLE);
  }, 120_000);

  test("cannot reach another preview through its published port", async () => {
    const a = await deployed();
    const b = await deployed();
    expect(await (await fetch(`http://${ip}:${b.port}/`)).text()).toBe("ok\n");
    expect(await reaches(a.container, "http://127.0.0.1:8080/")).toBe(true);
    expect(await reaches(a.container, `http://${ip}:${b.port}/`)).toBe(false);
  }, 180_000);

  test("cannot reach the host's own services or the metadata address", async () => {
    const { container } = await deployed();
    const server = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response("host") });
    try {
      expect(await (await fetch(`http://${ip}:${server.port}/`)).text()).toBe("host");
      const gateway = (
        await docker(
          "inspect",
          "--format",
          "{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}",
          container,
        )
      ).stdout;
      expect(await reaches(container, `http://${ip}:${server.port}/`)).toBe(false);
      expect(await reaches(container, `http://${gateway}:${server.port}/`)).toBe(false);
      expect(await reaches(container, "http://169.254.169.254/")).toBe(false);
    } finally {
      await server.stop(true);
    }
  }, 180_000);

  test("still resolves names", async () => {
    const { container } = await deployed();
    expect((await docker("exec", container, "nslookup", "github.com")).code).toBe(0);
  }, 180_000);
});
