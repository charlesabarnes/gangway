import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host, Preview, PreviewSource, Visibility } from "@gangway/shared/domain";
import { parse as parseYaml } from "yaml";
import { composeArgv } from "../docker/compose.ts";
import { AppError, unprocessable } from "../errors.ts";
import { redactString } from "../logger.ts";
import { buildStack, parseComposeModel, type ComposeModel } from "./compose-model.ts";
import type { PlannedRoute } from "./planned-route.ts";
import type { PreviewContext } from "./context.ts";
import type { Workdir } from "./source/workdir.ts";

export const PLAN_PROJECT = "gw-plan";
export const STACK_FILE = "gangway.stack.yaml";

export type Planned = { model: ComposeModel; resolved: unknown };

export async function readModel(
  ctx: PreviewContext,
  host: Host,
  wd: Workdir,
  composeFile: string,
): Promise<Planned> {
  const argv = composeArgv({
    project: PLAN_PROJECT,
    files: [join(wd.srcDir, composeFile)],
    projectDirectory: wd.srcDir,
    docker: ctx.docker,
    command: "config",
  });
  const r = await ctx.compose.capture(argv, host, { cwd: wd.srcDir });
  if (r.code !== 0)
    throw unprocessable("the compose file is not valid", {
      compose: redactString(r.stderr).slice(-2_000),
    });
  let resolved: unknown;
  try {
    resolved = parseYaml(r.stdout);
  } catch {
    throw new AppError("internal", "could not read `compose config` output");
  }

  // compose may return the path as given or with symlinks resolved (macOS temp dirs are symlinks).
  const model = parseComposeModel(PLAN_PROJECT, resolved, [wd.srcDir, await realpath(wd.srcDir)]);
  if (model.violations.length > 0) {
    throw unprocessable("the compose file asks for things a preview may not have", {
      violations: model.violations,
    });
  }
  return { model, resolved };
}

export type StackPlan = Planned & {
  preview: Preview;
  host: Host;
  routes: PlannedRoute[];
  visibility: Visibility;
};

export async function writeStack(
  ctx: PreviewContext,
  stackPath: string,
  s: StackPlan,
): Promise<string | null> {
  const source = ctx.previews.get(s.preview.id)?.source ?? s.preview.source;
  const network = sharedNetworkFor(ctx.instance, s.model, source);
  if (network) await ensureNetwork(ctx, s.host, network);
  await writeFile(
    stackPath,
    buildStack({
      resolved: s.resolved,
      planProject: PLAN_PROJECT,
      model: s.model,
      routes: s.routes,
      createdAt: s.preview.createdAt,
      ctx: {
        instance: ctx.instance,
        env: ctx.env,
        project: s.preview.project,
        hostId: s.host.id,
        visibility: s.visibility,
      },
      publishBind: s.host.publishBind,
      origin: ctx.origin,
      sharedNetwork: network,
      limits: ctx.limits?.(),
    }),
    { mode: 0o600 },
  );
  return network;
}

/**
 * Once a rebuilt stack is up on the shared network, its old per-project network holds an
 * address pool for nothing, and so does the earlier shared network once its last preview has
 * moved off it. The daemon refuses to remove a network that still has containers.
 */
export async function dropProjectNetwork(
  ctx: PreviewContext,
  host: Host,
  project: string,
): Promise<void> {
  const docker = ctx.docker ?? "docker";
  const cwd = await mkdtemp(join(tmpdir(), "gangway-net-"));
  try {
    for (const name of [`${project}_default`, `gw-${ctx.instance}-shared`])
      await ctx.compose.capture([docker, "network", "rm", name], host, { cwd });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export function sharedNetworkFor(
  instance: string,
  model: ComposeModel,
  source: PreviewSource,
): string | null {
  const choice = "network" in source && source.network ? source.network : "auto";
  const single = model.services.length === 1 && model.networks.every((n) => n === "default");
  if (choice === "isolated") return null;
  if (choice === "shared" && !single)
    throw unprocessable(
      "network: shared is for a single service; a preview with add-ons or several services keeps its own network",
    );
  return single ? `gw-${instance}-previews` : null;
}

async function ensureNetwork(ctx: PreviewContext, host: Host, name: string): Promise<void> {
  const docker = ctx.docker ?? "docker";
  const cwd = await mkdtemp(join(tmpdir(), "gangway-net-"));
  try {
    const found = await ctx.compose.capture([docker, "network", "inspect", name], host, { cwd });
    if (found.code === 0) return;
    const create = (...opts: string[]) =>
      ctx.compose.capture(
        [docker, "network", "create", "--label", `gangway.instance=${ctx.instance}`, ...opts, name],
        host,
        { cwd },
      );
    // Previews share the network for its address pool, not to talk: one could otherwise reach
    // another's container directly, past its password or sign-in.
    let made = await create("--opt", "com.docker.network.bridge.enable_icc=false");
    if (made.code !== 0 && !/already exists/.test(made.stderr)) {
      ctx.logger.warn(
        "the engine refused an isolated network; previews on it can reach each other",
        {
          network: name,
          stderr: made.stderr.trim(),
        },
      );
      made = await create();
    }
    if (made.code !== 0 && !/already exists/.test(made.stderr))
      throw new AppError("internal", `could not create the ${name} network: ${made.stderr.trim()}`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
