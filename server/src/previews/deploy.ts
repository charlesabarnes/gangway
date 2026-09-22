/**
 * The deploy pipeline (§5). ADR-0003: this is the ONE code path that can create a
 * preview, and there is not an HTTP type in it.
 *
 * Two halves, split where the answer to "what is my URL?" becomes known:
 *
 *   plan   (awaited by the caller)  source -> `compose config` -> policy -> hostnames
 *                                   and ports -> preview row + route rows
 *   run    (background)             stack file -> build -> up -> healthy -> answering
 *
 * A failure while planning leaves NOTHING behind -- no row, no route, no container --
 * and surfaces as a 4xx to the caller. A failure while running leaves a `failed` preview
 * whose URL serves the log tail (§6.1), because by then someone may be watching it.
 *
 * §5: "Write the route row before starting containers, never after." The rows are
 * written at the end of `plan`; `compose up` is in `run`. That ordering is structural.
 */
import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectNameFor, type Host, type Preview, type PreviewSource, type Route, type Visibility } from "../../../shared/src/domain.ts";
import { slugify } from "../../../shared/src/hostname.ts";
import { publicOriginFor } from "../../../shared/src/url.ts";
import { actorId, type Actor } from "../auth/actor.ts";
import { buildArgv, composeArgv, downArgv, parseComposePs, psArgv, runArgv, upArgv, type ComposeSpec } from "../docker/compose.ts";
import { AppError, conflict } from "../errors.ts";
import { redactString } from "../logger.ts";
import { allocatePorts } from "../routing/ports.ts";
import { place } from "../scheduler/placement.ts";
import { sleep } from "../util/async.ts";
import { parseDuration } from "../util/duration.ts";
import { ulid } from "../util/ulid.ts";
import { parse as parseYaml } from "yaml";
import { buildStack, composeForDockerfile, composeForImage, parseComposeModel, planRoutes, selectExposed, type ComposeModel, type PlannedRoute } from "./compose-model.ts";
import type { PreviewContext } from "./context.ts";
import { cloneRepo } from "./source/git.ts";
import { assertNoEscapingSymlinks, COMPOSE_FILENAMES, inspectComposeFile } from "./source/guard.ts";
import { extractTarball, type TarballSource } from "./source/tarball.ts";
import type { Workdir } from "./source/workdir.ts";

export type DeploySource =
  | { kind: "image"; image: string; port: number; env?: Record<string, string> | undefined }
  /** Cloned by the server itself. `port` is only for a repo with a Dockerfile and no compose file. */
  | { kind: "git"; repo: string; ref: string; port?: number | undefined }
  /**
   * A pull request's head (ADR-0011). `credential` is presented to git and forgotten: it is
   * not on the recorded source, not in a label, not in the log.
   */
  | { kind: "pr"; repo: string; number: number; sha: string; cloneUrl: string; credential: string | undefined; port?: number | undefined }
  /** A tar or tar.gz of the project, compose file (or Dockerfile) at its root. */
  | { kind: "tarball"; archive: TarballSource; port?: number | undefined; digest?: string | undefined };

export type DeployInput = {
  actor: Actor;
  source: DeploySource;
  /** The hostname stem. Defaults to something derived from the source. */
  name?: string | undefined;
  visibility?: Visibility | undefined;
  /** A duration (`12h`, `7d`), or null for no expiry. */
  ttl?: string | null | undefined;
  hostId?: string | undefined;
};

export type PreviewUrl = { service: string; url: string; primary: boolean };

export type DeployResult = {
  preview: Preview;
  urls: PreviewUrl[];
  /** Settles when the pipeline does. Resolves with the final preview -- awake OR failed. */
  done: Promise<Preview>;
};

const unprocessable = (m: string, d?: Record<string, unknown>) => new AppError("unprocessable", m, d);

/** A placeholder `-p` for the config passes, which run before the real name is known. */
const PLAN_PROJECT = "gw-plan";
const COMPOSE_FILE = "compose.yaml";
/** What we actually `up`: compose's canonical output with our changes applied. */
const STACK_FILE = "gangway.stack.yaml";

/** 50 bits, lowercase base32 without lookalikes. §8.3: "unguessable suffix in the hostname". */
function unguessable(): string {
  const alphabet = "abcdefghjkmnpqrstvwxyz0123456789";
  return Array.from(randomBytes(10), (b) => alphabet[b % 32]).join("");
}

function defaultName(source: DeploySource): string {
  if (source.kind === "tarball") return "preview";
  if (source.kind === "pr") return `${source.repo.split("/").pop() ?? "repo"}-pr-${source.number}`;
  // "ghcr.io/acme/web-app:1.2" -> "web-app";  "https://github.com/acme/web-app.git" -> "web-app"
  const from = source.kind === "git" ? source.repo.replace(/\/+$/, "").replace(/\.git$/, "") : source.image;
  const last = from.split("/").pop() ?? from;
  return slugify(last.split(/[:@]/)[0] ?? last) || "preview";
}

export function urlsFor(ctx: Pick<PreviewContext, "table" | "origin">, previewId: string): PreviewUrl[] {
  return ctx.table.forPreview(previewId)
    .map((e) => ({ service: e.service, url: `${publicOriginFor(e.hostname, ctx.origin)}/`, primary: e.primary }))
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.service.localeCompare(b.service));
}

/* ------------------------------------------------------------------ plan */

type Materialized = { source: PreviewSource; composeFile: string };

/** §5 steps 2-3: put the source on disk and find its compose file -- trusting neither. */
async function writeSource(ctx: PreviewContext, id: string, source: DeploySource, wd: Workdir): Promise<Materialized> {
  if (source.kind === "image") {
    await writeFile(join(wd.srcDir, COMPOSE_FILE), composeForImage(source), { mode: 0o600 });
    return { source: { kind: "image", image: source.image }, composeFile: COMPOSE_FILE };
  }

  let recorded: PreviewSource;
  if (source.kind === "git") {
    const cloned = await cloneRepo({ repo: source.repo, ref: source.ref, destDir: wd.srcDir, logger: ctx.logger, ...ctx.git });
    ctx.logs.append(id, "system", `cloned ${source.repo} @ ${cloned.ref} (${cloned.sha.slice(0, 12)}) in ${cloned.durationMs}ms`);
    recorded = { kind: "git", repo: source.repo, ref: source.ref };
  } else if (source.kind === "pr") {
    const cloned = await cloneRepo({ repo: source.cloneUrl, ref: source.sha, destDir: wd.srcDir, token: source.credential, logger: ctx.logger, ...ctx.git });
    ctx.logs.append(id, "system", `fetched ${source.repo}#${source.number} @ ${cloned.sha.slice(0, 12)} in ${cloned.durationMs}ms`);
    recorded = { kind: "pr", repo: source.repo, number: source.number, sha: source.sha };
  } else {
    const r = await extractTarball(source.archive, wd.srcDir);
    ctx.logs.append(id, "system", `unpacked ${r.files} files, ${r.totalBytes} bytes`);
    recorded = { kind: "tarball", uploadId: id };
  }

  // Both checks come BEFORE `compose config`, which opens whatever the file points it at.
  await assertNoEscapingSymlinks(wd.srcDir);
  const found = await inspectComposeFile(wd.srcDir);
  if (found) return { source: recorded, composeFile: found };

  const dockerfile = await lstat(join(wd.srcDir, "Dockerfile")).catch(() => null);
  if (!dockerfile?.isFile()) {
    throw unprocessable(`the source has no compose file (${COMPOSE_FILENAMES.join(", ")}) and no Dockerfile at its root`);
  }
  if (source.port === undefined) {
    throw unprocessable("the source has a Dockerfile but no compose file, so `port` is required: the port the app listens on inside the container");
  }
  await writeFile(join(wd.srcDir, COMPOSE_FILE), composeForDockerfile({ port: source.port }), { mode: 0o600 });
  return { source: recorded, composeFile: COMPOSE_FILE };
}

type Planned = { model: ComposeModel; resolved: unknown };

async function readModel(ctx: PreviewContext, host: Host, wd: Workdir, composeFile: string): Promise<Planned> {
  const argv = composeArgv({
    project: PLAN_PROJECT, files: [join(wd.srcDir, composeFile)], projectDirectory: wd.srcDir, docker: ctx.docker,
    // YAML, not `--format json`: JSON output drops service-level x-gangway. See compose-model.ts.
    command: "config",
  });
  const r = await ctx.compose.capture(argv, host, { cwd: wd.srcDir });
  if (r.code !== 0) throw unprocessable("the compose file is not valid", { compose: redactString(r.stderr).slice(-2_000) });
  let resolved: unknown;
  try { resolved = parseYaml(r.stdout); } catch { throw new AppError("internal", "could not read `compose config` output"); }

  // Both spellings: compose may hand back the path as given or with symlinks resolved
  // (on macOS every temp dir is one).
  const model = parseComposeModel(PLAN_PROJECT, resolved, [wd.srcDir, await realpath(wd.srcDir)]);
  if (model.violations.length > 0) {
    throw unprocessable("the compose file asks for things a preview may not have", { violations: model.violations });
  }
  return { model, resolved };
}

export async function deploy(ctx: PreviewContext, input: DeployInput): Promise<DeployResult> {
  const id = ulid(ctx.now());
  // §9: placement is decided here and nowhere else, even while there is one host.
  const host = place({ capability: "preview", hostId: input.hostId }, ctx.hosts.list());
  const wd = await ctx.workdirs.create(id);

  let preview: Preview;
  let planned: Planned;
  let routes: PlannedRoute[];
  let visibility: Visibility;
  try {
    const { source, composeFile } = await writeSource(ctx, id, input.source, wd);
    planned = await readModel(ctx, host, wd, composeFile);
    const { model } = planned;
    const exposed = selectExposed(model);

    const defaults = ctx.defaults();
    visibility = input.visibility ?? model.x.visibility ?? defaults.visibility;
    // A private preview is opened by logging in to the UI (net/gate.ts). With the UI switched
    // off there is no login page to send anyone to: say so now, not with a dead link later.
    if (visibility === "private" && ctx.privateAvailable?.() === false) {
      throw unprocessable("private previews need the web UI, which is switched off (surfaces.ui); use unlisted instead");
    }

    const ttlText = input.ttl === undefined ? (model.x.ttl ?? defaults.ttl) : input.ttl;
    const ttlMs = ttlText === null ? null : parseDuration(ttlText);
    if (ttlText !== null && ttlMs === null) throw unprocessable(`ttl ${JSON.stringify(ttlText)} is not a duration like 12h or 7d`);

    const stem = slugify(input.name ?? defaultName(input.source));
    if (stem === "") throw unprocessable("name has no usable characters");
    const slug = visibility === "unlisted" ? `${stem}-${unguessable()}` : stem;
    const project = projectNameFor(ctx.instance, slug);

    const existing = ctx.previews.getByProject(project);
    if (existing && existing.state !== "destroyed") {
      throw conflict(`a preview named "${slug}" already exists`, { previewId: existing.id, state: existing.state });
    }

    // ---- from here to the end of the block is SYNCHRONOUS. Ports are allocated from
    // the route table and claimed in the route table with no await in between, so two
    // concurrent deploys cannot be handed the same port.
    routes = planRoutes({
      previewId: id, slug, baseDomain: ctx.baseDomain(), host, exposed,
      allocate: (n) => allocatePorts(host.ports, ctx.table.usedPorts(host.upstream.address), n, host.id),
    });
    if (existing) {
      ctx.previews.delete(existing.id);
      ctx.logs.remove(existing.id);
    }
    // The stack's own idle choice is pinned on the row; the server default is read at sweep time.
    const idleAfterMs = model.x.idle === undefined ? null : model.x.idle === "never" ? 0 : parseDuration(model.x.idle);
    preview = ctx.previews.create({
      id, project, hostId: host.id, state: "building", source, visibility,
      ttlExpiresAt: ttlMs === null ? null : new Date(ctx.now() + ttlMs), idleAfterMs,
    });
    try {
      for (const route of routes) {
        ctx.table.apply({ route: { ...route, createdAt: preview.createdAt }, hostId: host.id, project, visibility, state: "building" });
      }
    } catch (e) {
      ctx.table.removePreview(id);
      ctx.previews.delete(id);
      throw /UNIQUE|PRIMARY/i.test(String(e)) ? conflict("that hostname is already taken by another preview") : e;
    }
    // ---- end synchronous block
  } catch (e) {
    await wd.cleanup();
    ctx.logs.remove(id);
    throw e;
  }

  const urls = urlsFor(ctx, id);
  ctx.bus.publish("preview.created", { project: preview.project, by: actorId(input.actor), urls: urls.map((u) => u.url) }, id);
  ctx.logs.append(id, "system", `deploying ${preview.project} to host ${host.id}`);
  // After the rows exist: a rejected deploy made nothing, so there is nothing to have done.
  ctx.audit?.record(input.actor, "preview.deploy", id, {
    new: { project: preview.project, visibility, source: input.source.kind, hostId: host.id, urls: urls.map((u) => u.url) },
  });

  const abort = new AbortController();
  const done = run(ctx, { preview, host, wd, ...planned, routes, visibility, signal: abort.signal })
    .finally(() => { ctx.inflight.delete(id); });
  ctx.inflight.set(id, { abort, done });

  return { preview, urls, done };
}

/* ------------------------------------------------------------------ run */

type RunInput = {
  preview: Preview; host: Host; wd: Workdir; model: ComposeModel; resolved: unknown;
  routes: PlannedRoute[]; visibility: Visibility; signal: AbortSignal;
};

export class StepFailed extends Error {
  readonly exitCode: number | null;
  constructor(message: string, exitCode: number | null = null) {
    super(message);
    this.exitCode = exitCode;
  }
}

async function run(ctx: PreviewContext, r: RunInput): Promise<Preview> {
  const { preview, host, wd } = r;
  const id = preview.id;
  const log = (line: string) => ctx.logs.append(id, "system", line);
  const stackPath = join(wd.dir, STACK_FILE);
  // ONE file. The user's compose.yaml is not on this command line: it has already been
  // read, by compose itself, into the document the stack file was built from.
  const base = { project: preview.project, files: [stackPath], projectDirectory: wd.srcDir, docker: ctx.docker };

  /** Streams a compose command into the preview log; throws unless it exits 0. */
  const step = async (what: string, argv: string[], stream: "build" | "seed" | "stdout") => {
    log(`$ compose ${what}`);
    for await (const ev of ctx.compose.stream(argv, host, { cwd: wd.srcDir, signal: r.signal })) {
      if (ev.type === "line") ctx.logs.append(id, ev.stream === "stderr" && stream === "stdout" ? "stderr" : stream, ev.line);
      else if (ev.code !== 0) throw new StepFailed(`compose ${what} exited ${ev.code}${ev.signal ? ` (${ev.signal})` : ""}`, ev.code);
    }
    r.signal.throwIfAborted();
  };

  let upAttempted = false;
  try {
    await writeFile(stackPath, buildStack({
      resolved: r.resolved, planProject: PLAN_PROJECT,
      model: r.model, routes: r.routes, createdAt: preview.createdAt,
      ctx: { instance: ctx.instance, env: ctx.env, project: preview.project, hostId: host.id, visibility: r.visibility },
      publishBind: host.publishBind, origin: ctx.origin,
    }), { mode: 0o600 });

    const toBuild = r.model.services.filter((s) => s.hasBuild).map((s) => s.name);
    if (toBuild.length > 0) {
      const buildId = ulid(ctx.now());
      ctx.builds?.start({ id: buildId, previewId: id, services: toBuild });
      try {
        await step("build", buildArgv(base, toBuild), "build");
        ctx.builds?.finish(buildId, "succeeded", 0);
      } catch (e) {
        ctx.builds?.finish(buildId, r.signal.aborted ? "cancelled" : "failed", e instanceof StepFailed ? e.exitCode : null);
        throw e;
      }
    }

    ctx.states.transition(id, "starting");
    upAttempted = true;
    await step("up", upArgv(base, ["--no-build", "--remove-orphans"]), "stdout");

    const target: WaitTarget = { previewId: id, host, routes: r.routes, signal: r.signal, ps: psArgv(base, ["--all"]), cwd: wd.srcDir };
    await waitHealthy(ctx, target);

    // §7.3 / ADR-0012: the seed runs once, healthy but not yet routed. Failing it fails the preview.
    const seed = seedFor(r.model, r.routes);
    if (seed) {
      log(`seeding: ${seed.command} (in ${seed.service})`);
      await step("run (seed)", runArgv(base, seed.service, ["sh", "-c", seed.command], ["--no-deps", "-T"]), "seed");
    }

    await waitAnswering(ctx, target);

    log("awake");
    return ctx.states.transition(id, "awake");
  } catch (e) {
    // destroy() aborted us and owns the preview from here; do not fight it for the state.
    if (r.signal.aborted) return ctx.previews.get(id) ?? preview;

    const message = redactString(e instanceof Error ? e.message : String(e));
    if (!(e instanceof StepFailed)) ctx.logger.error("deploy pipeline error", { previewId: id, err: e });
    log(`FAILED: ${message}`);
    if (upAttempted) await salvage(ctx, r);
    return ctx.states.transition(id, "failed", message);
  } finally {
    await wd.cleanup();
  }
}

/** The seed hook as `{ service, command }`, the primary route's service filling in. */
export function seedFor(model: ComposeModel, routes: PlannedRoute[]): { service: string; command: string } | null {
  const seed = model.x.seed;
  if (seed === undefined) return null;
  if (typeof seed !== "string") return seed;
  const primary = routes.find((r) => r.primary) ?? routes[0];
  if (!primary) throw unprocessable("x-gangway.seed names no service and nothing is exposed to run it in");
  return { service: primary.service, command: seed };
}

/** What the two waits need: a deploy has it from its plan, a wake from the route table. */
export type WaitTarget = {
  previewId: string;
  host: Host;
  routes: Pick<Route, "service" | "hostname" | "upstream" | "containerPort">[];
  signal: AbortSignal;
  /** The `ps` argv -- with the stack file for a deploy, file-less for a wake. */
  ps: string[];
  cwd: string;
};

/** §5 step 7 / §7.4: gate on healthchecks, not on container start. */
export async function waitHealthy(ctx: PreviewContext, r: WaitTarget): Promise<void> {
  const deadline = Date.now() + ctx.timings.startTimeoutMs;
  const argv = r.ps;
  let last = "";
  for (;;) {
    r.signal.throwIfAborted();
    const res = await ctx.compose.capture(argv, r.host, { cwd: r.cwd, signal: r.signal });
    const rows = res.code === 0 ? parseComposePs(res.stdout) : [];
    const routed = new Set(r.routes.map((x) => x.service));

    for (const c of rows) {
      const died = c.state === "dead" || (c.state === "exited" && (c.exitCode !== 0 || routed.has(c.service)));
      if (died) throw new StepFailed(`service "${c.service}" exited${c.exitCode === null ? "" : ` with code ${c.exitCode}`}`);
      if (c.health === "unhealthy") throw new StepFailed(`service "${c.service}" is unhealthy`);
    }
    // A one-shot service (a migration) that exited 0 is done, not broken.
    const waiting = rows.filter((c) => !(c.state === "exited" && c.exitCode === 0))
      .filter((c) => c.state !== "running" || (c.health !== null && c.health !== "healthy"));
    const seen = new Set(rows.map((c) => c.service));
    const missing = [...routed].filter((s) => !seen.has(s));
    if (rows.length > 0 && waiting.length === 0 && missing.length === 0) return;

    const status = [...waiting.map((c) => `${c.service}: ${c.health ?? c.state}`), ...missing.map((s) => `${s}: not created`)].join(", ");
    if (status !== last) { ctx.logs.append(r.previewId, "system", `waiting for ${status || "containers"}`); last = status; }
    if (Date.now() >= deadline) throw new StepFailed(`timed out after ${Math.round(ctx.timings.startTimeoutMs / 1000)}s waiting for ${status || "containers"}`);
    await sleep(ctx.timings.pollIntervalMs);
  }
}

/** Running is not listening. Do not call it awake until the URL would actually work. */
export async function waitAnswering(ctx: PreviewContext, r: WaitTarget): Promise<void> {
  const deadline = Date.now() + ctx.timings.probeTimeoutMs;
  let pending = [...r.routes];
  for (;;) {
    r.signal.throwIfAborted();
    const results = await Promise.all(pending.map((route) => ctx.probe(route, r.host)));
    pending = pending.filter((_, i) => !results[i]);
    if (pending.length === 0) return;
    if (Date.now() >= deadline) {
      throw new StepFailed(`${pending.map((p) => `${p.service}:${p.containerPort}`).join(", ")} never answered HTTP -- is that the right port, and does the app listen on 0.0.0.0?`);
    }
    await sleep(ctx.timings.pollIntervalMs);
  }
}

/**
 * A failed stack is torn down -- it is holding ports and memory on a box that runs real
 * workloads -- but its last words are kept first, because the container logs are the
 * only thing that says WHY, and the failure page shows them (§6.1).
 */
async function salvage(ctx: PreviewContext, r: RunInput): Promise<void> {
  const empty = await mkdtemp(join(tmpdir(), "gangway-salvage-"));
  try {
    const logs = await ctx.compose.capture(
      composeArgv({ project: r.preview.project, files: [], command: "logs", args: ["--no-color", "--tail", "60"], docker: ctx.docker }),
      r.host, { cwd: empty },
    );
    if (logs.stdout) ctx.logs.append(r.preview.id, "stdout", logs.stdout);
    await ctx.compose.capture(downArgv({ project: r.preview.project, files: [], docker: ctx.docker }), r.host, { cwd: empty });
  } catch (e) {
    ctx.logger.warn("could not tear down a failed stack; the reconciler will", { previewId: r.preview.id, err: e });
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
}
