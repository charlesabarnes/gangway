import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host, Preview, PreviewSource, Visibility } from "@gangway/shared/domain";
import { parse as parseYaml } from "yaml";
import { composeArgv } from "../docker/compose.ts";
import { AppError, unprocessable } from "../errors.ts";
import { redactString } from "../logger.ts";
import { obj } from "../util/json.ts";
import { buildStack, parseComposeModel, type ComposeModel } from "./compose-model.ts";
import { buildSecretViolations } from "./compose-policy.ts";
import type { PlannedRoute } from "./planned-route.ts";
import type { PreviewContext } from "./context.ts";
import { withDotenv, type OwnStack } from "./own-stack.ts";
import type { Workdir } from "./source/workdir.ts";

export const PLAN_PROJECT = "gw-plan";
export const STACK_FILE = "gangway.stack.yaml";

export type Planned = { model: ComposeModel; resolved: unknown };

export async function readModel(
  ctx: PreviewContext,
  host: Host,
  wd: Workdir,
  { composeFile, dotenv }: OwnStack,
): Promise<Planned> {
  const argv = composeArgv({
    project: PLAN_PROJECT,
    files: [join(wd.srcDir, composeFile)],
    projectDirectory: wd.srcDir,
    docker: ctx.docker,
    command: "config",
  });
  const r = await withDotenv(wd.srcDir, dotenv, () =>
    ctx.compose.capture(argv, host, { cwd: wd.srcDir }),
  );
  if (r.code !== 0) {
    throw unprocessable("the compose file is not valid", {
      compose: redactString(r.stderr).slice(-2_000),
    });
  }
  let resolved: unknown;
  try {
    resolved = parseYaml(r.stdout);
  } catch {
    throw new AppError("internal", "could not read `compose config` output");
  }

  // compose may return the path as given or with symlinks resolved (macOS temp dirs are symlinks).
  const model = parseComposeModel(PLAN_PROJECT, resolved, [wd.srcDir, await realpath(wd.srcDir)]);
  const violations = [...model.violations, ...buildSecretViolations(obj(resolved), dotenv ?? {})];
  if (violations.length > 0) {
    throw unprocessable("the compose file asks for things a preview may not have", { violations });
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
  const wanted = sharedNetworkFor(ctx.instance, s.model, source);
  const network = wanted && (await isolatedNetwork(ctx, s.host, wanted)) ? wanted : null;
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
    for (const name of [`${project}_default`, `gw-${ctx.instance}-shared`]) {
      await ctx.compose.capture([docker, "network", "rm", name], host, { cwd });
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export function sharedNetworkFor(
  instance: string,
  model: ComposeModel,
  source: PreviewSource,
): string | null {
  const choice = ("network" in source ? source.network : undefined) ?? "auto";
  const single = model.services.length === 1 && model.networks.every((n) => n === "default");
  if (choice === "isolated") {
    return null;
  }
  if (choice === "shared" && !single) {
    throw unprocessable(
      "network: shared is for a single service; a preview with add-ons or several services keeps its own network",
    );
  }
  return single ? `gw-${instance}-previews` : null;
}

export const ICC_OPTION = "com.docker.network.bridge.enable_icc";

const iccOff = (inspected: string) => {
  try {
    const net = obj((JSON.parse(inspected) as unknown[])[0]);
    return obj(net["Options"])[ICC_OPTION] === "false";
  } catch {
    return false;
  }
};

// Shared for its address pool, not to talk: one preview could otherwise reach another's container
// past its password. Without the engine keeping them apart, each preview keeps its own network.
async function isolatedNetwork(ctx: PreviewContext, host: Host, name: string): Promise<boolean> {
  const docker = ctx.docker ?? "docker";
  const cwd = await mkdtemp(join(tmpdir(), "gangway-net-"));
  const run = (argv: string[]) => ctx.compose.capture([docker, "network", ...argv], host, { cwd });
  try {
    let found = await run(["inspect", name]);
    if (found.code !== 0) {
      const made = await run([
        "create",
        "--label",
        `gangway.instance=${ctx.instance}`,
        "--opt",
        `${ICC_OPTION}=false`,
        name,
      ]);
      if (made.code === 0) {
        return true;
      }
      if (!/already exists/.test(made.stderr)) {
        ctx.logger.warn("the engine refused an isolated network; each preview keeps its own", {
          network: name,
          stderr: made.stderr.trim(),
        });
        return false;
      }
      found = await run(["inspect", name]);
    }
    if (found.code === 0 && iccOff(found.stdout)) {
      return true;
    }
    ctx.logger.warn("the shared network lets previews reach each other; each keeps its own", {
      network: name,
    });
    return false;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
