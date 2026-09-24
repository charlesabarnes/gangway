import { GANGWAY_FILES } from "./gangway-file.ts";
import { runtimeById } from "./runtimes.ts";
import { resolveAddons, suggestAddons } from "./plan/addons.ts";
import { applySettings, MAX_PLAN_FILE_BYTES, readConfig } from "./plan/config.ts";
import { planOwnStack, wantsOwnStack } from "./plan/own-stack.ts";
import { applyProcfile } from "./plan/procfile.ts";
import {
  scopeToRoot,
  useExplicitRoot,
  useNestedRoot,
  warnNestedContainerFiles,
} from "./plan/root.ts";
import { STATIC_OUTPUTS } from "./plan/rule-context.ts";
import { chooseRuntime, pickVersion } from "./plan/runtime-choice.ts";
import { applyRuntimeRules } from "./plan/runtime-rules.ts";
import type { AppPlan, PlanInput } from "./plan/types.ts";

export { cmdText } from "./plan/command-text.ts";
export { MAX_PLAN_FILE_BYTES };
export type {
  AddonRequest,
  AppPlan,
  ArtifactMeta,
  PlanChoice,
  PlanInput,
  Reason,
} from "./plan/types.ts";

export const PLAN_FILES = [
  ...GANGWAY_FILES,
  "package.json",
  "Procfile",
  "composer.json",
  "deno.json",
  "deno.jsonc",
  "wrangler.toml",
  "wrangler.json",
  "wrangler.jsonc",
  "requirements.txt",
  "pyproject.toml",
  "artifact.md",
  "index.html",
] as const;

export const STATIC_BUILD_OUTPUTS: readonly string[] = STATIC_OUTPUTS;

export function planError(p: AppPlan): string | null {
  if (p.issues.length > 0)
    return `gangway.yml: ${p.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ")}`;
  const e = p.reasons.find((r) => r.level === "error");
  return e ? `${e.found}: ${e.then}` : null;
}

export function planFilePaths(paths: readonly string[]): string[] {
  const names = new Set<string>(PLAN_FILES);
  return paths.filter((p) => {
    const parts = p.split("/");
    return parts.length <= 2 && names.has(parts[parts.length - 1]!);
  });
}

const emptyPlan = (): AppPlan => ({
  kind: "runtime",
  runtime: null,
  version: null,
  image: null,
  root: "",
  install: null,
  build: null,
  start: null,
  release: null,
  serve: { kind: "server" },
  docroot: "",
  entry: null,
  port: null,
  health: null,
  env: {},
  stack: {},
  configFile: null,
  reasons: [],
  issues: [],
  addons: [],
  suggested: [],
  sqlSeed: null,
  artifact: null,
});

export function planApp(input: PlanInput): AppPlan {
  const plan = emptyPlan();
  const choice = input.runtime ?? "auto";
  let cfg = readConfig(plan, input, "");
  if (choice === "own" || wantsOwnStack(input, choice, cfg)) return planOwnStack(plan, input, cfg);

  const explicitRoot = cfg?.file?.root;
  if (explicitRoot !== undefined) {
    if (!useExplicitRoot(plan, input, explicitRoot)) return plan;
  } else if (!cfg) {
    cfg = useNestedRoot(plan, input);
  }
  const scope = scopeToRoot(input, plan.root);
  const file = cfg?.file ?? null;
  plan.configFile = cfg?.name ?? null;
  if (plan.issues.length > 0) return plan;
  warnNestedContainerFiles(plan, scope.have);

  const runtime = chooseRuntime(input, choice, file, scope, plan.reasons);
  const rt = runtimeById(runtime);
  plan.runtime = runtime;
  if (!pickVersion(plan, rt, file)) return plan;
  applySettings(plan, file);
  const procfile = applyProcfile(plan, file, scope.text);
  applyRuntimeRules({ plan, file, have: scope.have, text: scope.text, rt, procfile }, runtime);

  if (file?.port !== undefined && plan.serve.kind === "static")
    plan.reasons.push({ level: "info", found: `port: ${file.port}`, then: "nginx listens there" });
  resolveAddons(plan, input, file, scope.have);
  if (plan.addons.length > 0 && plan.serve.kind === "static")
    plan.reasons.push({
      level: "warn",
      found: "add-ons on a static site",
      then: "nothing in a static site can connect to them",
    });
  suggestAddons(plan, scope.text);
  return plan;
}
