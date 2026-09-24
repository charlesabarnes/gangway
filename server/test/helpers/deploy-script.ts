import { existsSync, readFileSync } from "node:fs";
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
import type { PreviewContext } from "../../src/previews/context.ts";
import type { DeployInput } from "../../src/previews/deploy-types.ts";
import { fixedPolicy } from "../../src/previews/policy.ts";
import { PreviewLogs } from "../../src/previews/logs.ts";
import { Workdirs } from "../../src/previews/source/workdir.ts";
import { PreviewStates } from "../../src/previews/state.ts";
import { RouteTable } from "../../src/routing/table.ts";
import { tempDb } from "./db.ts";
import { seededHosts } from "./hosts.ts";
import { silentLogger } from "./logger.ts";
import { ACTOR } from "./preview-context.ts";

const cmdOf = (argv: string[]) =>
  argv.find((a) => ["config", "build", "up", "ps", "down", "logs"].includes(a))!;

/** What the fake compose answers. A queue repeats its last entry once the others are used. */
export type Script = {
  /** What the compose file resolves to. Defaults to reading the generated image stack. */
  config?: (file: string) => unknown;
  up?: { code: number; lines?: string[]; hang?: boolean };
  ps?: Array<Record<string, unknown>[]>;
  down?: { code: number; stderr?: string } | "throw";
  probe?: boolean[];
};

/** A preview context over three ports, whose compose follows `script` and records every call. */
export function setupScriptedDeploy(script: Script = {}) {
  const { db, dir } = tempDb();
  const hosts = seededHosts(db, { portRangeStart: 31000, portRangeEnd: 31002 });
  const previews = new PreviewsRepo(db);
  const table = new RouteTable(new RoutesRepo(db));
  const bus = new EventBus(new EventsRepo(db));
  const logs = new PreviewLogs(dir);

  const calls: {
    cmd: string;
    argv: string[];
    cwd: string;
    routesAtCall: number;
    stack: string | null;
  }[] = [];
  const record = (argv: string[], cwd: string) => {
    const f = argv[argv.indexOf("--file") + 1];
    calls.push({
      cmd: cmdOf(argv),
      argv,
      cwd,
      routesAtCall: table.size,
      stack: f && existsSync(f) ? readFileSync(f, "utf8") : null,
    });
  };
  const psQueue = [...(script.ps ?? [[{ Service: "web", State: "running", Health: "" }]])];
  const probeQueue = [...(script.probe ?? [true])];

  const compose: ComposeRunner = {
    async *stream(argv, _host, o): AsyncGenerator<ComposeEvent> {
      record(argv, o.cwd);
      const up = script.up ?? { code: 0, lines: ["Container gw-web-1  Started"] };
      for (const line of up.lines ?? []) yield { type: "line", stream: "stderr", line };
      if (up.hang)
        await new Promise<void>((resolve) => o.signal?.addEventListener("abort", () => resolve()));
      o.signal?.throwIfAborted();
      yield { type: "exit", code: up.code, signal: null };
    },
    async capture(argv, _host, o): Promise<ComposeResult> {
      // The shared preview network is plumbing, not part of a stack's compose sequence.
      if (argv[1] === "network") return { code: 0, stdout: "[]", stderr: "", signal: null };
      record(argv, o.cwd);
      const ok = (stdout: string): ComposeResult => ({ code: 0, stdout, stderr: "", signal: null });
      switch (cmdOf(argv)) {
        case "config": {
          const file = argv[argv.indexOf("--file") + 1]!;
          const doc = script.config?.(file) ?? {
            services: JSON.parse(readFileSync(file, "utf8")).services,
            networks: { default: { name: "gw-plan_default" } },
          };
          if (doc === "invalid")
            return {
              code: 15,
              stdout: "",
              stderr: "yaml: line 3: did not find expected key",
              signal: null,
            };
          return ok(JSON.stringify(doc));
        }
        case "ps":
          return ok(
            (psQueue.length > 1 ? psQueue.shift()! : psQueue[0]!)
              .map((r) => JSON.stringify(r))
              .join("\n"),
          );
        case "logs":
          return ok("web-1  | Error: listen EADDRINUSE");
        case "down":
          if (script.down === "throw") throw new Error("connect ECONNREFUSED");
          return {
            code: script.down?.code ?? 0,
            stdout: "",
            stderr: script.down?.stderr ?? "",
            signal: null,
          };
      }
      return ok("");
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
    logs,
    compose,
    states: new PreviewStates(previews, table, bus),
    workdirs: new Workdirs(dir),
    probe: async () => (probeQueue.length > 1 ? probeQueue.shift()! : probeQueue[0]!),
    logger: silentLogger(),
    timings: { startTimeoutMs: 150, probeTimeoutMs: 150, pollIntervalMs: 5 },
    now: Date.now,
    inflight: new Map(),
    teardowns: new Set(),
    builds: new BuildsRepo(db),
    audit: new Audit(new AuditRepo(db), silentLogger()),
  };
  const input = (o: Partial<DeployInput> = {}): DeployInput => ({
    actor: ACTOR,
    source: { kind: "image", image: "ghcr.io/acme/web-app:1.2", port: 3000 },
    visibility: "public",
    ...o,
  });
  /** Event types, with the new state appended to state changes (`preview.state:awake`). */
  const events = () =>
    new EventsRepo(db)
      .since(0)
      .map((e) => `${e.type}${e.payload["state"] ? `:${String(e.payload["state"])}` : ""}`);
  return { ctx, calls, input, events, dir, table, previews, logs };
}
