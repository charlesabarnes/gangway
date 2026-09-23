import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Host, Preview, Visibility } from "@gangway/shared/domain";
import { parse as parseYaml } from "yaml";
import { composeArgv } from "../docker/compose.ts";
import { AppError, unprocessable } from "../errors.ts";
import { redactString } from "../logger.ts";
import { buildStack, parseComposeModel, type ComposeModel } from "./compose-model.ts";
import type { PlannedRoute } from "./compose-routes.ts";
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
): Promise<void> {
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
    }),
    { mode: 0o600 },
  );
}
