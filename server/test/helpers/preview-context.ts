/**
 * A real PreviewContext over a real (temp) SQLite, with only the compose runner faked.
 * For service-layer tests that need deploys to exist but not a daemon.
 */
import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import { HostConfigSchema } from "../../src/config.ts";
import { migrate } from "../../src/db/migrate.ts";
import { Audit } from "../../src/audit/audit.ts";
import { AuditRepo, BuildsRepo, EventsRepo, HostsRepo, PreviewsRepo, RoutesRepo } from "../../src/db/repos/index.ts";
import { openDatabase } from "../../src/db/sqlite.ts";
import type { ComposeEvent, ComposeResult } from "../../src/docker/compose.ts";
import type { ComposeRunner } from "../../src/docker/runner.ts";
import { EventBus } from "../../src/events/bus.ts";
import { seedHosts } from "../../src/hosts/seed.ts";
import { Logger } from "../../src/logger.ts";
import type { PreviewContext } from "../../src/previews/context.ts";
import { deploy, type DeployInput } from "../../src/previews/deploy.ts";
import { PreviewLogs } from "../../src/previews/logs.ts";
import { Workdirs } from "../../src/previews/source/workdir.ts";
import { PreviewStates } from "../../src/previews/state.ts";
import { RouteTable } from "../../src/routing/table.ts";
import { staticTokenVerifier, type Actor } from "../../src/auth/actor.ts";

const MIGRATIONS = join(import.meta.dir, "../../migrations");
export const ACTOR = staticTokenVerifier("x")("x") as Actor;
export const DAY = 86_400_000;
const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

export function setupPreviewContext() {
  const dir = mkdtempSync(join(tmpdir(), "gangway-jobs-"));
  tmps.push(dir);
  const { db } = openDatabase({ path: join(dir, "g.db") });
  migrate(db, MIGRATIONS);
  const hosts = new HostsRepo(db);
  seedHosts([HostConfigSchema.parse({})], hosts);
  const previews = new PreviewsRepo(db);
  const routes = new RoutesRepo(db);
  const table = new RouteTable(routes);
  const bus = new EventBus(new EventsRepo(db));
  const fake = { downs: [] as string[], ups: 0, builds: 0, buildExit: 0, failDownFor: new Set<string>(), planDelayMs: 0 };
  const compose: ComposeRunner = {
    async *stream(argv): AsyncGenerator<ComposeEvent> {
      if (argv.includes("build")) {
        fake.builds++;
        yield { type: "line", stream: "stderr", line: "#1 [internal] load build definition from Dockerfile" };
        yield { type: "exit", code: fake.buildExit, signal: null };
        return;
      }
      fake.ups++; yield { type: "exit", code: 0, signal: null }; },
    async capture(argv): Promise<ComposeResult> {
      const cmd = argv.find((a) => ["config", "ps", "down", "logs"].includes(a))!;
      const project = argv[argv.indexOf("--project-name") + 1] ?? "";
      if (cmd === "down") {
        fake.downs.push(project);
        if (fake.failDownFor.has(project)) return { code: 1, stdout: "", stderr: "daemon said no", signal: null };
      }
      if (cmd === "config" && fake.planDelayMs) await Bun.sleep(fake.planDelayMs);
      if (cmd === "config") {
        // What the real `config` does that matters here: make build contexts absolute.
        const doc = parseYaml(await Bun.file(argv[argv.indexOf("--file") + 1]!).text()) as { services?: Record<string, { build?: string | { context?: string } }> };
        const projectDir = argv[argv.indexOf("--project-directory") + 1]!;
        for (const s of Object.values(doc.services ?? {})) {
          if (s.build === undefined) continue;
          const b = typeof s.build === "string" ? { context: s.build } : s.build;
          s.build = { ...b, context: resolvePath(projectDir, b.context ?? ".") };
        }
        return { code: 0, stdout: JSON.stringify(doc), stderr: "", signal: null };
      }
      if (cmd === undefined && argv.includes("build")) fake.builds++;
      const stdout = cmd === "config" ? await Bun.file(argv[argv.indexOf("--file") + 1]!).text()
        : cmd === "ps" ? JSON.stringify({ Service: "web", State: "running" }) : "";
      return { code: 0, stdout, stderr: "", signal: null };
    },
  };
  const clock = { offset: 0 };
  const auditRepo = new AuditRepo(db);
  const ctx: PreviewContext = {
    instance: "default", env: "test", origin: { scheme: "https", port: 8443 },
    baseDomain: () => "preview.localhost", defaults: () => ({ ttl: "7d", visibility: "unlisted" }),
    hosts, previews, table, bus, compose, logs: new PreviewLogs(dir), workdirs: new Workdirs(dir),
    states: new PreviewStates(previews, table, bus), probe: async () => true,
    logger: new Logger("error", {}, () => {}), timings: { startTimeoutMs: 200, probeTimeoutMs: 200, pollIntervalMs: 5 },
    now: () => Date.now() + clock.offset, inflight: new Map(), teardowns: new Set(),
    builds: new BuildsRepo(db),
    audit: new Audit(auditRepo, new Logger("error", {}, () => {})),
  };
  const lines: string[] = [];
  const logger = new Logger("info", {}, (l) => lines.push(l));
  const request = (name: string): DeployInput => ({ actor: ACTOR, name, visibility: "public", source: { kind: "image", image: "traefik/whoami:v1.10", port: 80 } });
  const deployed = async (name: string) =>
    (await deploy(ctx, { actor: ACTOR, name, visibility: "public", source: { kind: "image", image: "traefik/whoami:v1.10", port: 80 } })).done;
  return { request, ctx, db, audit: auditRepo, hosts, previews, routes, table, fake, clock, logger, lines, deployed };
}

