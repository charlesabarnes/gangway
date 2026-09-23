/**
 * A real PreviewContext over a real (temp) SQLite, with only the compose runner faked.
 * For service-layer tests that need deploys to exist but not a daemon.
 */
import { readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import { Audit } from "../../src/audit/audit.ts";
import {
  AuditRepo,
  BuildsRepo,
  EventsRepo,
  PreviewsRepo,
  RoutesRepo,
} from "../../src/db/repos/index.ts";
import type { ComposeEvent, ComposeResult } from "../../src/docker/compose.ts";
import type { ComposeRunner } from "../../src/docker/runner.ts";
import { EventBus } from "../../src/events/bus.ts";
import { Logger } from "../../src/logger.ts";
import type { PreviewContext } from "../../src/previews/context.ts";
import { fixedPolicy } from "../../src/previews/policy.ts";
import { deploy } from "../../src/previews/deploy.ts";
import type { DeployInput } from "../../src/previews/deploy-types.ts";
import { PreviewLogs } from "../../src/previews/logs.ts";
import { Workdirs } from "../../src/previews/source/workdir.ts";
import { PreviewStates } from "../../src/previews/state.ts";
import { RouteTable } from "../../src/routing/table.ts";
import { staticTokenVerifier, type Actor } from "../../src/auth/actor.ts";
import { tempDb } from "./db.ts";
import { seededHosts } from "./hosts.ts";
import { silentLogger } from "./logger.ts";

export const ACTOR = staticTokenVerifier("x")("x") as Actor;
export const DAY = 86_400_000;

export function setupPreviewContext() {
  const { db, dir } = tempDb();
  const hosts = seededHosts(db);
  const previews = new PreviewsRepo(db);
  const routes = new RoutesRepo(db);
  const table = new RouteTable(routes);
  const bus = new EventBus(new EventsRepo(db));
  const fake = {
    downs: [] as string[],
    ups: 0,
    builds: 0,
    buildExit: 0,
    failDownFor: new Set<string>(),
    planDelayMs: 0,
    runs: [] as string[][],
    runExit: 0,
    stops: [] as string[][],
    starts: [] as string[][],
    stopExit: 0,
    startExit: 0,
    psState: "running",
    answering: true,
    /** What each `up` was given: its extra env, and the registry login it could read at that moment. */
    upLogins: [] as { env: Record<string, string> | undefined; config: string | null }[],
    downArgvs: [] as string[][],
    /** The stack file each `up` was given, parsed (add-on tests read the sidecars from it). */
    stacks: [] as Record<string, unknown>[],
    /** Every argv the fake saw, in order. */
    all: [] as string[][],
    /** What `compose logs` prints: the containers' own output. */
    runtimeLog: "",
  };
  const compose: ComposeRunner = {
    async *stream(argv, _host, o): AsyncGenerator<ComposeEvent> {
      fake.all.push(argv);
      if (argv.includes("up") && argv.includes("--file")) {
        fake.stacks.push(
          JSON.parse(readFileSync(argv[argv.indexOf("--file") + 1]!, "utf8")) as Record<
            string,
            unknown
          >,
        );
      }
      if (argv.includes("up")) {
        const dir = o.env?.["DOCKER_CONFIG"];
        fake.upLogins.push({
          env: o.env,
          config: dir ? readFileSync(join(dir, "config.json"), "utf8") : null,
        });
      }
      if (argv.includes("build")) {
        fake.builds++;
        yield {
          type: "line",
          stream: "stderr",
          line: "#1 [internal] load build definition from Dockerfile",
        };
        yield { type: "exit", code: fake.buildExit, signal: null };
        return;
      }
      if (argv.includes("run")) {
        fake.runs.push(argv);
        yield { type: "line", stream: "stdout", line: "seeded 3 rows" };
        yield { type: "exit", code: fake.runExit, signal: null };
        return;
      }
      fake.ups++;
      yield { type: "exit", code: 0, signal: null };
    },
    async capture(argv): Promise<ComposeResult> {
      fake.all.push(argv);
      const cmd = argv.find((a) => ["config", "ps", "down", "logs", "stop", "start"].includes(a))!;
      const project = argv[argv.indexOf("--project-name") + 1] ?? "";
      if (cmd === "stop") {
        fake.stops.push(argv);
        return {
          code: fake.stopExit,
          stdout: "",
          stderr: fake.stopExit ? "cannot stop" : "",
          signal: null,
        };
      }
      if (cmd === "start") {
        fake.starts.push(argv);
        return {
          code: fake.startExit,
          stdout: "",
          stderr: fake.startExit ? "cannot start" : "",
          signal: null,
        };
      }
      if (cmd === "down") {
        fake.downs.push(project);
        fake.downArgvs.push(argv);
        if (fake.failDownFor.has(project))
          return { code: 1, stdout: "", stderr: "daemon said no", signal: null };
      }
      if (cmd === "config" && fake.planDelayMs) await Bun.sleep(fake.planDelayMs);
      if (cmd === "config") {
        // What the real `config` does that matters here: make build contexts absolute.
        const doc = parseYaml(await Bun.file(argv[argv.indexOf("--file") + 1]!).text()) as {
          services?: Record<string, { build?: string | { context?: string } }>;
        };
        const projectDir = argv[argv.indexOf("--project-directory") + 1]!;
        for (const s of Object.values(doc.services ?? {})) {
          if (s.build === undefined) continue;
          const b = typeof s.build === "string" ? { context: s.build } : s.build;
          s.build = { ...b, context: resolvePath(projectDir, b.context ?? ".") };
        }
        return { code: 0, stdout: JSON.stringify(doc), stderr: "", signal: null };
      }
      if (cmd === undefined && argv.includes("build")) fake.builds++;
      const stdout =
        cmd === "config"
          ? await Bun.file(argv[argv.indexOf("--file") + 1]!).text()
          : cmd === "ps"
            ? JSON.stringify({ Service: "web", State: fake.psState })
            : cmd === "logs"
              ? fake.runtimeLog
              : "";
      return { code: 0, stdout, stderr: "", signal: null };
    },
  };
  const clock = { offset: 0 };
  const auditRepo = new AuditRepo(db);
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
    probe: async () => fake.answering,
    logger: silentLogger(),
    timings: { startTimeoutMs: 200, probeTimeoutMs: 200, pollIntervalMs: 5 },
    now: () => Date.now() + clock.offset,
    inflight: new Map(),
    teardowns: new Set(),
    builds: new BuildsRepo(db),
    addonSecret: (previewId, addon) => `pw${previewId.slice(-10)}${addon}`.toLowerCase(),
    audit: new Audit(auditRepo, silentLogger()),
  };
  const lines: string[] = [];
  const logger = new Logger("info", {}, (l) => lines.push(l));
  const request = (name: string): DeployInput => ({
    actor: ACTOR,
    name,
    visibility: "public",
    source: { kind: "image", image: "traefik/whoami:v1.10", port: 80 },
  });
  const deployed = async (name: string) =>
    (
      await deploy(ctx, {
        actor: ACTOR,
        name,
        visibility: "public",
        source: { kind: "image", image: "traefik/whoami:v1.10", port: 80 },
      })
    ).done;
  return {
    request,
    ctx,
    db,
    audit: auditRepo,
    hosts,
    previews,
    routes,
    table,
    fake,
    clock,
    logger,
    lines,
    deployed,
  };
}
