import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  planApp,
  planError,
  planFilePaths,
  MAX_PLAN_FILE_BYTES,
  type AddonRequest,
  type AppPlan,
  type PlanChoice,
} from "@gangway/shared/app-plan";
import type { AddonChoice } from "@gangway/shared/addons";
import { runtimeById, type Detected } from "@gangway/shared/runtimes";
import { AppError, unprocessable } from "../errors.ts";
import type { RenderedAddons } from "./addons.ts";
import { composeForRuntime } from "./compose-generate.ts";
import { renderRuntime } from "./runtime-dockerfile.ts";
import { shq } from "./runtime-templates.ts";
import { GENERATED_DIR } from "./source/store.ts";
import { containedIn, DIR_MODE, FILE_MODE } from "./source/types.ts";

export type RuntimeChoice = PlanChoice;

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  GENERATED_DIR,
  "__pycache__",
  ".venv",
  "vendor",
]);
const MAX_WALK = 20_000;

async function listPaths(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (abs: string, rel: string): Promise<void> => {
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (out.length >= MAX_WALK) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(path.join(abs, e.name), r);
      } else if (e.isFile()) out.push(r);
    }
  };
  await walk(dir, "");
  return out.sort();
}

export async function planFromDisk(
  srcDir: string,
  choice: RuntimeChoice,
  opts: {
    previous?: Detected | undefined;
    addons?: readonly AddonRequest[] | undefined;
    previousAddons?: readonly AddonChoice[] | undefined;
  } = {},
): Promise<AppPlan> {
  const paths = await listPaths(srcDir);
  const files: Record<string, string> = {};
  for (const p of planFilePaths(paths)) {
    const abs = path.join(srcDir, p);
    const st = await lstat(abs).catch(() => null);
    if (!st?.isFile() || st.size > MAX_PLAN_FILE_BYTES) continue;
    files[p] = await readFile(abs, "utf8");
  }
  return planApp({ paths, files, runtime: choice, ...opts });
}

export function assertRunnable(plan: AppPlan): void {
  const err = planError(plan);
  if (err) throw unprocessable(err, { reasons: plan.reasons, issues: plan.issues });
}

const ALWAYS_BOUND = ["PUBLIC_URL", "GANGWAY_PREVIEW_ID"];

export async function writeRuntime(
  srcDir: string,
  plan: AppPlan,
  secrets: Record<string, string> | undefined,
  composePath: string,
  port?: number,
  sidecars?: RenderedAddons,
): Promise<{ composeFile: string; note: string }> {
  if (containedIn(srcDir, composePath))
    throw new AppError("internal", "the runtime compose file must be outside the build context");
  const env = { ...plan.env, ...(secrets ?? {}), ...(sidecars?.appEnv ?? {}) };
  const bindings = [...new Set([...ALWAYS_BOUND, ...Object.keys(env)])].sort();
  const rendered = renderRuntime(plan, bindings, port);
  const context = plan.root ? path.join(srcDir, plan.root) : srcDir;
  if (!containedIn(srcDir, context)) throw unprocessable("root: leaves the upload");
  const dir = path.join(context, GENERATED_DIR);
  const st = await lstat(dir).catch(() => null);
  if (st && !st.isDirectory())
    throw unprocessable(
      `${plan.root ? `${plan.root}/` : ""}${GENERATED_DIR} in the upload is not a directory; gangway writes its build files there`,
    );
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  await writeFile(path.join(dir, "Dockerfile"), rendered.dockerfile, { mode: FILE_MODE });
  await writeFile(
    path.join(dir, "Dockerfile.dockerignore"),
    ".git\n**/node_modules\n.gangway/out\n",
    { mode: FILE_MODE },
  );
  for (const [name, body] of Object.entries({ ...rendered.files, ...(sidecars?.files ?? {}) }))
    await writeFile(path.join(dir, name), body, { mode: FILE_MODE });
  const listen = port ?? plan.port ?? runtimeById(plan.runtime!).port;
  await writeFile(
    composePath,
    composeForRuntime({
      port: listen,
      env,
      context: plan.root || ".",
      stack: stackX(plan),
      health: plan.health,
      sidecars,
    }),
    { mode: 0o600 },
  );
  return { composeFile: path.relative(srcDir, composePath), note: rendered.note };
}

export function stackX(plan: AppPlan): Record<string, string> {
  const release =
    plan.release === null
      ? undefined
      : typeof plan.release === "string"
        ? plan.release
        : plan.release.map(shq).join(" ");
  return { ...plan.stack, ...(release !== undefined ? { release } : {}) };
}
