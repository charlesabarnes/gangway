import { cp, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { AddonChoice } from "@gangway/shared/addons";
import type { AddonRequest, AppPlan } from "@gangway/shared/app-plan";
import type { RuntimeId } from "@gangway/shared/runtimes";
import { AppError } from "../errors.ts";
import { renderAddons, type RenderedAddons } from "./addons.ts";
import type { PreviewContext } from "./context.ts";
import { ownStack } from "./own-stack.ts";
import { assertRunnable, planFromDisk, writeRuntime, type RuntimeChoice } from "./runtimes.ts";
import { assertNoEscapingSymlinks } from "./source/guard.ts";
import { GENERATED_DIR } from "./source/store.ts";
import type { Workdir } from "./source/workdir.ts";

export type PreparedUpload = {
  composeFile: string;
  runtime: RuntimeId | null;
  pristine: string | null;
  plan: AppPlan;
};

export type PlanOptions = {
  previous?: RuntimeId | "own" | undefined;
  addons?: readonly AddonRequest[] | undefined;
  previousAddons?: readonly AddonChoice[] | undefined;
};

async function keepPristine(ctx: PreviewContext, wd: Workdir): Promise<string | null> {
  if (!ctx.sources) return null;
  const pristine = join(wd.dir, "pristine");
  await rm(pristine, { recursive: true, force: true });
  await cp(wd.srcDir, pristine, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) =>
      src === wd.srcDir || !relative(wd.srcDir, src).split(sep).includes(GENERATED_DIR),
  });
  return pristine;
}

function renderSidecars(
  ctx: PreviewContext,
  logId: string,
  plan: AppPlan,
  env: Record<string, string> | undefined,
): RenderedAddons | undefined {
  if (plan.addons.length === 0) return undefined;
  const secret = ctx.addonSecret;
  if (!secret)
    throw new AppError(
      "internal",
      "add-ons are not available: no key to derive their passwords from",
    );
  const sidecars = renderAddons(
    plan.addons,
    (a) => secret(logId, a),
    plan.sqlSeed,
    plan.root || ".",
  );
  ctx.logs.mask(logId, sidecars.secrets);
  const shadowed = Object.keys(sidecars.appEnv).filter(
    (k) => env?.[k] !== undefined || plan.env[k] !== undefined,
  );
  if (shadowed.length > 0)
    ctx.logs.append(
      logId,
      "system",
      `add-ons set ${shadowed.join(", ")}, replacing the value${shadowed.length === 1 ? "" : "s"} from secrets or gangway.yml`,
    );
  return sidecars;
}

type Upload = {
  logId: string;
  wd: Workdir;
  choice: RuntimeChoice;
  env: Record<string, string> | undefined;
  port: number | undefined;
};

async function writePlannedRuntime(
  ctx: PreviewContext,
  { logId, wd, choice, env, port }: Upload,
  plan: AppPlan,
  sidecars: RenderedAddons | undefined,
): Promise<string> {
  const { composeFile, note } = await writeRuntime(
    wd.srcDir,
    plan,
    env,
    join(wd.dir, "runtime.compose.yaml"),
    port,
    sidecars,
  );
  ctx.logs.append(
    logId,
    "system",
    `${choice === "auto" ? "detected " : ""}runtime ${plan.runtime!}: ${note}`,
  );
  const secrets = Object.keys(env ?? {}).length;
  if (secrets > 0)
    ctx.logs.append(
      logId,
      "system",
      `passing ${secrets} secret(s) to the container as environment`,
    );
  return composeFile;
}

export async function prepareUpload(
  ctx: PreviewContext,
  logId: string,
  wd: Workdir,
  choice: RuntimeChoice,
  env: Record<string, string> | undefined,
  port: number | undefined,
  opts: PlanOptions = {},
): Promise<PreparedUpload> {
  await assertNoEscapingSymlinks(wd.srcDir);
  const pristine = await keepPristine(ctx, wd);
  const plan = await planFromDisk(wd.srcDir, choice, opts);
  assertRunnable(plan);
  for (const r of plan.reasons)
    ctx.logs.append(
      logId,
      "system",
      `plan: ${r.level === "info" ? "" : `${r.level}: `}${r.found} -> ${r.then}`,
    );
  const sidecars = renderSidecars(ctx, logId, plan, env);
  if (plan.kind === "own") {
    if (choice === "auto")
      ctx.logs.append(logId, "system", "detected the upload's own compose file / Dockerfile");
    return {
      composeFile: await ownStack(ctx, logId, wd.srcDir, env, port, plan, sidecars),
      runtime: null,
      pristine,
      plan,
    };
  }
  const upload = { logId, wd, choice, env, port };
  const composeFile = await writePlannedRuntime(ctx, upload, plan, sidecars);
  return { composeFile, runtime: plan.runtime!, pristine, plan };
}
