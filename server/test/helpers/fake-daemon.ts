/** Real boot(); compose starts HTTP fixtures on the allocated ports and the fake daemon lists them. */
import { boot, type Running } from "../../src/boot.ts";
import { loadConfig } from "../../src/config.ts";
import type { ContainerSummary } from "../../src/docker/client.ts";
import type { ComposeEvent, ComposeResult } from "../../src/docker/compose.ts";
import type { ComposeRunner } from "../../src/docker/runner.ts";
import { onCleanup } from "./cleanup.ts";
import { freePort } from "./free-port.ts";
import { silentLogger } from "./logger.ts";

export async function bootWithFakeDaemon(
  stateDir: string,
  upstreamPort: number,
  seed?: ContainerSummary[],
  env: Record<string, string> = {},
) {
  const fixtures = new Map<string, ReturnType<typeof Bun.serve>>();
  /** What the fake daemon would list: one "container" per `up`, labelled as the stack file said. */
  const containers = new Map<string, ContainerSummary>();
  const project = (argv: string[]) => argv[argv.indexOf("--project-name") + 1]!;
  // What `stop` and `start` need to remember: how to bring a project's stand-in back.
  const starters = new Map<string, () => void>();
  const stopped = new Set<string>();
  const compose: ComposeRunner = {
    async *stream(argv): AsyncGenerator<ComposeEvent> {
      const web = (await Bun.file(argv[argv.indexOf("--file") + 1]!).json()).services.web;
      const serve = () =>
        fixtures.set(
          project(argv),
          Bun.serve({
            hostname: web.ports[0].host_ip,
            port: Number(web.ports[0].published),
            fetch: async (req) => {
              const slow = new URL(req.url).searchParams.get("slow");
              if (slow) await Bun.sleep(Number(slow));
              if (new URL(req.url).pathname === "/xff")
                return Response.json({ xff: req.headers.get("x-forwarded-for") });
              if (new URL(req.url).pathname === "/cookie")
                return Response.json({
                  cookie: req.headers.get("cookie"),
                  path: new URL(req.url).pathname + new URL(req.url).search,
                });
              return Response.json({
                iAm: "the container",
                host: req.headers.get("host"),
                proto: req.headers.get("x-forwarded-proto"),
                publicUrl: web.environment.PUBLIC_URL,
              });
            },
          }),
        );
      serve();
      starters.set(project(argv), serve);
      containers.set(project(argv), {
        id: `c-${project(argv)}`,
        names: [`${project(argv)}-web-1`],
        image: web.image,
        state: "running",
        status: "Up",
        createdAt: new Date(),
        labels: web.labels,
        ports: [
          {
            ip: web.ports[0].host_ip,
            containerPort: web.ports[0].target,
            hostPort: Number(web.ports[0].published),
            protocol: "tcp",
          },
        ],
      });
      yield { type: "line", stream: "stderr", line: " Container web-1  Started" };
      yield { type: "exit", code: 0, signal: null };
    },
    async capture(argv): Promise<ComposeResult> {
      const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", signal: null });
      if (argv.includes("config")) {
        const file = argv[argv.indexOf("--file") + 1]!;
        return ok(
          JSON.stringify({
            services: (await Bun.file(file).json()).services,
            networks: { default: { name: "gw-plan_default" } },
          }),
        );
      }
      if (argv.includes("ps"))
        return ok(
          JSON.stringify({
            Service: "web",
            State: stopped.has(project(argv)) ? "exited" : "running",
            ExitCode: 0,
          }),
        );
      if (argv.includes("stop")) {
        void fixtures.get(project(argv))?.stop(true);
        fixtures.delete(project(argv));
        stopped.add(project(argv));
      }
      if (argv.includes("start")) {
        starters.get(project(argv))?.();
        stopped.delete(project(argv));
      }
      if (argv.includes("down")) {
        void fixtures.get(project(argv))?.stop(true);
        fixtures.delete(project(argv));
        containers.delete(project(argv));
        starters.delete(project(argv));
      }
      return ok("");
    },
  };

  const config = loadConfig(
    {
      GANGWAY_STATE_DIR: stateDir,
      GANGWAY_LISTEN_ADDRESS: "127.0.0.1",
      GANGWAY_LISTEN_PORT: String(await freePort()),
      GANGWAY_LISTEN_HTTP_PORT: "",
      GANGWAY_ADMIN_TOKEN: "gw_e2e_admin_token_0123456789abcdef",
      ...env,
    },
    { hosts: [{ portRangeStart: upstreamPort, portRangeEnd: upstreamPort }] },
  );
  config.publicPort = config.listenPort;

  // Injected, always: the default client would dial whatever Docker socket this machine has.
  const clients = {
    for: () => ({
      hostId: "local",
      info: async () => ({ Name: "test-daemon", OperatingSystem: "Linux" }),
      listContainers: async () => [...containers.values(), ...(seed ?? [])],
      stopContainer: async () => {},
    }),
  };
  const running = await boot(config, {
    compose,
    clients,
    announce: () => {},
    logger: silentLogger(),
    timings: { pollIntervalMs: 10 },
  });
  onCleanup(async () => {
    await running.stop();
    for (const f of fixtures.values()) void f.stop(true);
  });
  return Object.assign(running, { daemon: containers });
}

export const client =
  (r: Running) =>
  (host: string, path: string, init: RequestInit = {}) =>
    fetch(`https://127.0.0.1:${r.listener.port}${path}`, {
      ...init,
      headers: {
        host,
        authorization: `Bearer ${r.adminToken}`,
        ...(init.headers as Record<string, string> | undefined),
      },
      tls: { rejectUnauthorized: false },
      redirect: "manual",
    } as RequestInit);
