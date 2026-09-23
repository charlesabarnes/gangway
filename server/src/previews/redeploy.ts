/**
 * Rebuild in place (ADR-0015): an uploaded preview's source changes -- edited in the UI, or
 * replaced by a new upload -- and the SAME preview is rebuilt: same id, hostname, ports,
 * routes, template, TTL and clearance.
 *
 * Like a deploy, two halves:
 *
 *   plan   (awaited)     new source on disk -> runtime -> `compose config` -> the same
 *                        services on the same ports? -> the new source is KEPT
 *   run    (background)  build (the old version keeps serving) -> swap (`starting`, the
 *                        proxy shows its building page for the second `up` takes) -> awake
 *
 * A plan that fails changes nothing: not the kept source, not the preview. A build that
 * fails leaves the old version serving and says so. A failure after `up` is `failed`, like
 * a deploy's, and the next save can recover it.
 */
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Host, Preview, PreviewSource } from "../../../shared/src/domain.ts";
import { actorId, mayRebuild, type Actor } from "../auth/actor.ts";
import { buildArgv, composeArgv, psArgv, runArgv, upArgv } from "../docker/compose.ts";
import { AppError, conflict, forbidden, notFound } from "../errors.ts";
import { redactString } from "../logger.ts";
import { ulid } from "../util/ulid.ts";
import { addonServices } from "./addons.ts";
import { buildStack, selectExposed, type PlannedRoute } from "./compose-model.ts";
import type { PreviewContext } from "./context.ts";
import {
  healthOf,
  PLAN_PROJECT,
  prepareUpload,
  readModel,
  releaseFor,
  salvage,
  STACK_FILE,
  StepFailed,
  stepper,
  waitAnswering,
  waitHealthy,
  type WaitTarget,
} from "./deploy.ts";
import type { RuntimeChoice } from "./runtimes.ts";
import type { AddonRequest, AppPlan } from "../../../shared/src/app-plan.ts";
import { GENERATED_DIR } from "./source/store.ts";
import { extractTarball, type TarballSource } from "./source/tarball.ts";
import { DIR_MODE, FILE_MODE, resolveWithin } from "./source/types.ts";

/** One file's new text, or null to delete it. */
export type SourceEdits = Record<string, string | null>;

export type RedeployInput = {
  actor: Actor;
  previewId: string;
  change: { kind: "replace"; archive: TarballSource } | { kind: "edit"; files: SourceEdits };
  /** Omitted: the runtime the preview was built with. */
  runtime?: RuntimeChoice | undefined;
  /** ADR-0017. Omitted: gangway.yml's, else the ones it has. `[]` removes them (their data stays until destroy). */
  addons?: readonly AddonRequest[] | undefined;
};

export type RedeployOutcome = {
  preview: Preview;
  buildId: string;
  outcome: "succeeded" | "failed";
  error?: string;
};
export type RedeployResult = {
  preview: Preview;
  buildId: string;
  done: Promise<RedeployOutcome>;
  plan?: AppPlan | undefined;
};

const unprocessable = (m: string, d?: Record<string, unknown>) =>
  new AppError("unprocessable", m, d);

/** Said the same way by REST and MCP. */
export const REBUILD_REFUSAL =
  'this preview was deployed by someone else: "previews.update_own" covers only your own, and rebuilding any preview needs "previews.update" (the `update` scope for a token or an agent)';

/** Paths an edit may name: relative, forward-slashed, no `..`, nothing in a `.gangway/` (at any depth: a nested app's root has one). */
export function checkEditPath(p: string): string {
  const bad = (why: string) =>
    unprocessable(`cannot write ${JSON.stringify(p.slice(0, 200))}: ${why}`);
  if (p.length === 0 || p.length > 255) throw bad("a path is 1-255 characters");
  if (p.includes("\0") || p.includes("\\")) throw bad("no NUL or backslash");
  if (p.startsWith("/")) throw bad("paths are relative to the upload's root");
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === ".."))
    throw bad("no empty, `.` or `..` segments");
  if (parts.includes(GENERATED_DIR)) throw bad(`${GENERATED_DIR}/ is written by gangway`);
  return p;
}

/** Applies edits to a copy of the kept source. No component on the way may be a symlink. */
async function applyEdits(srcDir: string, files: SourceEdits): Promise<number> {
  let n = 0;
  for (const [rel, text] of Object.entries(files)) {
    checkEditPath(rel);
    const abs = resolveWithin(srcDir, rel);
    if (!abs) throw unprocessable(`cannot write ${JSON.stringify(rel)}: it leaves the upload`);
    const parts = rel.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const st = await lstat(join(srcDir, ...parts.slice(0, i))).catch(() => null);
      if (st?.isSymbolicLink())
        throw unprocessable(
          `cannot write ${JSON.stringify(rel)}: ${parts.slice(0, i).join("/")} is a symlink`,
        );
      if (st && i < parts.length && !st.isDirectory())
        throw unprocessable(
          `cannot write ${JSON.stringify(rel)}: ${parts.slice(0, i).join("/")} is a file`,
        );
      if (st && i === parts.length && st.isDirectory())
        throw unprocessable(`cannot write ${JSON.stringify(rel)}: it is a directory`);
    }
    if (text === null) {
      await rm(abs, { force: true });
    } else {
      // The extractor's modes: COPY keeps them, and a web server in the image may not be root.
      await mkdir(dirname(abs), { recursive: true, mode: DIR_MODE });
      await writeFile(abs, text, { mode: FILE_MODE });
    }
    n++;
  }
  return n;
}

const routesOf = (ctx: PreviewContext, previewId: string): PlannedRoute[] =>
  ctx.table.forPreview(previewId).map((e) => ({
    hostname: e.hostname,
    previewId: e.previewId,
    service: e.service,
    containerPort: e.containerPort,
    upstream: { host: e.upstreamHost, port: e.upstreamPort },
    primary: e.primary,
  }));

export async function redeploy(ctx: PreviewContext, input: RedeployInput): Promise<RedeployResult> {
  const id = input.previewId;
  const current = ctx.previews.get(id);
  if (!current || current.state === "destroyed") throw notFound(`no such preview: ${id}`);
  // ADR-0021: one check for every adapter. The routes and tools only knew the actor may
  // rebuild SOMETHING; whose preview this is needs the row.
  if (!mayRebuild(input.actor, ctx.previews.ownerOf(id))) throw forbidden(REBUILD_REFUSAL);
  if (current.source.kind !== "tarball" || !ctx.sources || !(await ctx.sources.has(id))) {
    throw conflict(
      "only an uploaded preview can be rebuilt from a new source; this one keeps none",
    );
  }
  const host = ctx.hosts.get(current.hostId);
  if (!host) throw new AppError("internal", `preview ${id} is on unknown host ${current.hostId}`);

  // ---- synchronous from the checks to the claim: two saves cannot both get past here.
  const preview = ctx.previews.get(id)!;
  if (!["awake", "asleep", "failed"].includes(preview.state)) {
    throw conflict(`the preview is ${preview.state}; wait for it to settle`, {
      state: preview.state,
    });
  }
  if (ctx.inflight.has(id) || ctx.teardowns.has(id))
    throw conflict("a deploy of this preview is still running");
  const abort = new AbortController();
  let settle!: (o: RedeployOutcome) => void;
  const done = new Promise<RedeployOutcome>((r) => {
    settle = r;
  });
  ctx.inflight.set(id, { abort, done: done.then((o) => o.preview) });
  // ---- end synchronous block

  const buildId = ulid(ctx.now());
  const wd = await ctx.workdirs.create(buildId).catch((e) => {
    ctx.inflight.delete(id);
    throw e;
  });
  const source = preview.source as Extract<PreviewSource, { kind: "tarball" }>;
  const routes = routesOf(ctx, id);
  let appPlan: AppPlan | undefined;
  let plan: {
    resolved: unknown;
    model: Awaited<ReturnType<typeof readModel>>["model"];
    runtime: PreviewSource;
    addonServices: string[];
  };
  try {
    if (routes.length === 0) throw conflict("the preview has no routes to rebuild behind");
    if (input.change.kind === "replace") {
      const r = await extractTarball(input.change.archive, wd.srcDir);
      ctx.logs.append(
        id,
        "system",
        `rebuilding from a new upload (requested by ${actorId(input.actor)}): ${r.files} files, ${r.totalBytes} bytes`,
      );
    } else {
      await ctx.sources.copyTo(id, wd.srcDir);
      const n = await applyEdits(wd.srcDir, input.change.files);
      ctx.logs.append(
        id,
        "system",
        `rebuilding with ${n} edited file${n === 1 ? "" : "s"} (requested by ${actorId(input.actor)})`,
      );
    }
    // Asked for, else the upload's gangway.yml, else what it was built as before (ADR-0016).
    const choice: RuntimeChoice = input.runtime ?? "auto";
    const env =
      preview.secretLevel === null || preview.secretLevel === "none"
        ? {}
        : ctx.secretsFor?.(preview.projectId, preview.secretLevel);
    // The port the preview already routes to: an own Dockerfile needs it, and a runtime
    // listens on it, so switching runtimes keeps the preview.
    const port = routes.length === 1 ? routes[0]!.containerPort : undefined;
    const up = await prepareUpload(ctx, id, wd, choice, env, port, {
      previous: source.runtime ?? "own",
      addons: input.addons,
      previousAddons: source.addons,
    });
    const { model, resolved } = await readModel(ctx, host, wd, up.composeFile);

    // The same services on the same ports, or it is a new preview: its routes, hostnames
    // and ports were settled when it was deployed.
    const want = new Set(routes.map((r) => `${r.service}:${r.containerPort}`));
    const got = new Set(selectExposed(model).map((e) => `${e.service}:${e.containerPort}`));
    if (want.size !== got.size || [...want].some((k) => !got.has(k))) {
      throw unprocessable(
        "the new source exposes different services or ports than this preview; deploy it as a new preview instead",
        {
          expected: [...want].sort(),
          got: [...got].sort(),
        },
      );
    }

    // Accepted: this is the source now, whether or not it builds (ADR-0015).
    if (up.pristine) await ctx.sources.adopt(id, up.pristine);
    const next: PreviewSource = {
      kind: "tarball",
      uploadId: source.uploadId,
      ...(up.runtime ? { runtime: up.runtime } : {}),
      ...(up.plan.addons.length ? { addons: up.plan.addons } : {}),
    };
    if (JSON.stringify(next) !== JSON.stringify(source)) ctx.previews.setSource(id, next);
    plan = { resolved, model, runtime: next, addonServices: addonServices(up.plan.addons) };
    appPlan = up.plan;
  } catch (e) {
    await wd.cleanup();
    ctx.inflight.delete(id);
    settle({
      preview: ctx.previews.get(id) ?? preview,
      buildId,
      outcome: "failed",
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }

  ctx.bus.publish("preview.redeploy", { phase: "started", buildId, by: actorId(input.actor) }, id);
  ctx.audit?.record(input.actor, "preview.redeploy", id, {
    new: {
      project: preview.project,
      change: input.change.kind,
      runtime: plan.runtime.kind === "tarball" ? (plan.runtime.runtime ?? "own") : null,
      buildId,
    },
  });

  void run(ctx, { preview, host, wd, routes, buildId, signal: abort.signal, ...plan })
    .then(
      (o) => settle(o),
      (e: unknown) =>
        settle({
          preview: ctx.previews.get(id) ?? preview,
          buildId,
          outcome: "failed",
          error: String(e),
        }),
    )
    .finally(() => {
      ctx.inflight.delete(id);
    });

  return { preview: ctx.previews.get(id)!, buildId, done, plan: appPlan };
}

type RunInput = {
  preview: Preview;
  host: Host;
  wd: Awaited<ReturnType<PreviewContext["workdirs"]["create"]>>;
  routes: PlannedRoute[];
  buildId: string;
  signal: AbortSignal;
  resolved: unknown;
  model: Awaited<ReturnType<typeof readModel>>["model"];
  /** ADR-0017: started (or left running) and healthy BEFORE the release, while the old app still serves. */
  addonServices: string[];
};

async function run(ctx: PreviewContext, r: RunInput): Promise<RedeployOutcome> {
  const { preview, host, wd, buildId } = r;
  const id = preview.id;
  const log = (line: string) => ctx.logs.append(id, "system", line);
  const stackPath = join(wd.dir, STACK_FILE);
  const base = {
    project: preview.project,
    files: [stackPath],
    projectDirectory: wd.srcDir,
    docker: ctx.docker,
  };
  const step = stepper(ctx, { previewId: id, host, cwd: wd.srcDir, signal: r.signal });
  const outcome = (o: "succeeded" | "failed", error?: string): RedeployOutcome => {
    ctx.bus.publish("preview.redeploy", { phase: o, buildId, ...(error ? { error } : {}) }, id);
    return {
      preview: ctx.previews.get(id) ?? preview,
      buildId,
      outcome: o,
      ...(error ? { error } : {}),
    };
  };

  // A failed preview has nothing serving: say "building" while it does.
  if (ctx.previews.get(id)?.state === "failed") ctx.states.transition(id, "building");

  let upAttempted = false;
  try {
    await writeFile(
      stackPath,
      buildStack({
        resolved: r.resolved,
        planProject: PLAN_PROJECT,
        model: r.model,
        routes: r.routes,
        createdAt: preview.createdAt,
        ctx: {
          instance: ctx.instance,
          env: ctx.env,
          project: preview.project,
          hostId: host.id,
          visibility: preview.visibility,
        },
        publishBind: host.publishBind,
        origin: ctx.origin,
      }),
      { mode: 0o600 },
    );

    const before = await imageIds(ctx, host, base, wd.srcDir);
    const toBuild = r.model.services.filter((s) => s.hasBuild).map((s) => s.name);
    if (toBuild.length > 0) {
      ctx.builds?.start({ id: buildId, previewId: id, services: toBuild });
      try {
        await step("build", buildArgv(base, toBuild), "build");
        ctx.builds?.finish(buildId, "succeeded", 0);
      } catch (e) {
        ctx.builds?.finish(
          buildId,
          r.signal.aborted ? "cancelled" : "failed",
          e instanceof StepFailed ? e.exitCode : null,
        );
        throw e;
      }
    }

    // ADR-0017: the add-ons first, alone. Running ones are left as they are (same config,
    // no recreate); a new one starts on its volume. The app is not touched yet.
    if (r.addonServices.length > 0) {
      await step(
        "up (add-ons)",
        upArgv(base, ["--no-build", "--no-deps", ...r.addonServices]),
        "stdout",
      );
      await waitHealthy(ctx, {
        previewId: id,
        host,
        routes: [],
        signal: r.signal,
        ps: psArgv(base, ["--all", ...r.addonServices]),
        cwd: wd.srcDir,
      });
    }

    // ADR-0016: the release runs against the NEW image while the old version still serves.
    // Failing it is failing the build: nothing has been swapped yet.
    const release = releaseFor(r.model, r.routes);
    if (release) {
      log(`release: ${release.command} (in ${release.service})`);
      await step(
        "run (release)",
        runArgv(base, release.service, ["sh", "-c", release.command], ["--no-deps", "-T"]),
        "seed",
      );
    }

    r.signal.throwIfAborted();
    ctx.states.transition(id, "starting");
    upAttempted = true;
    await step("up", upArgv(base, ["--no-build", "--remove-orphans"]), "stdout");
    const target: WaitTarget = {
      previewId: id,
      host,
      routes: r.routes,
      signal: r.signal,
      ps: psArgv(base, ["--all"]),
      cwd: wd.srcDir,
      health: healthOf(r.model),
    };
    await waitHealthy(ctx, target);
    await waitAnswering(ctx, target);
    log("rebuilt: awake");
    ctx.states.transition(id, "awake");
    await removeReplaced(ctx, host, base, wd.srcDir, before, id);
    return outcome("succeeded");
  } catch (e) {
    // destroy() aborted us and owns the preview from here.
    if (r.signal.aborted)
      return {
        preview: ctx.previews.get(id) ?? preview,
        buildId,
        outcome: "failed",
        error: "cancelled",
      };
    const message = redactString(e instanceof Error ? e.message : String(e));
    if (!(e instanceof StepFailed))
      ctx.logger.error("redeploy pipeline error", { previewId: id, err: e });
    const state = ctx.previews.get(id)?.state;
    if (!upAttempted && state !== "building") {
      log(`rebuild FAILED: ${message} -- the previous version is still serving`);
      return outcome("failed", message);
    }
    log(`FAILED: ${message}`);
    if (upAttempted) await salvage(ctx, { preview, host });
    ctx.states.transition(id, "failed", message);
    return outcome("failed", message);
  } finally {
    await wd.cleanup();
  }
}

type Base = {
  project: string;
  files: string[];
  projectDirectory: string;
  docker: string | undefined;
};

/** The image ids the project's containers run now. Empty on any failure: cleanup is best-effort. */
async function imageIds(
  ctx: PreviewContext,
  host: Host,
  base: Base,
  cwd: string,
): Promise<Set<string>> {
  try {
    const res = await ctx.compose.capture(
      composeArgv({ ...base, command: "images", args: ["--quiet"] }),
      host,
      { cwd },
    );
    return new Set(
      res.code === 0
        ? res.stdout
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => /^(sha256:)?[0-9a-f]{12,64}$/.test(l))
        : [],
    );
  } catch {
    return new Set();
  }
}

/**
 * The rebuild moved `<project>-<service>` to a new image; the old one is left with no tag.
 * Removed only when it has NO tag and NO digest -- an image built here and now unreferenced.
 * A pulled image, even one pinned by digest, has a digest, and may be the operator's.
 */
async function removeReplaced(
  ctx: PreviewContext,
  host: Host,
  base: Base,
  cwd: string,
  before: Set<string>,
  previewId: string,
): Promise<void> {
  if (before.size === 0) return;
  const after = await imageIds(ctx, host, base, cwd);
  const docker = ctx.docker ?? "docker";
  const empty = await mkdtemp(join(tmpdir(), "gangway-rmi-"));
  try {
    for (const img of before) {
      if (after.has(img)) continue;
      const res = await ctx.compose.capture(
        [docker, "image", "inspect", "--format", "{{len .RepoTags}} {{len .RepoDigests}}", img],
        host,
        { cwd: empty },
      );
      if (res.code !== 0 || res.stdout.trim() !== "0 0") continue;
      const removed = await ctx.compose.capture([docker, "image", "rm", img], host, { cwd: empty });
      if (removed.code === 0)
        ctx.logs.append(
          previewId,
          "system",
          `removed the replaced image ${img.replace(/^sha256:/, "").slice(0, 12)}`,
        );
    }
  } catch (e) {
    ctx.logger.warn("could not remove a replaced image", { previewId, err: e });
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
}
