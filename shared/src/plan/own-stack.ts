import { detectRuntime } from "../runtimes.ts";
import { resolveAddons } from "./addons.ts";
import { applySettings, type ConfigRead } from "./config.ts";
import type { AppPlan, PlanChoice, PlanInput } from "./types.ts";

const COMPOSE_NAMES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

const atRoot = (paths: readonly string[]): string[] => paths.filter((p) => !p.includes("/"));

export function wantsOwnStack(
  input: PlanInput,
  choice: Exclude<PlanChoice, "own">,
  cfg: ConfigRead | null,
): boolean {
  if (choice !== "auto" || cfg?.file?.runtime) return false;
  if (input.previous !== undefined) return input.previous === "own";
  return detectRuntime(atRoot(input.paths)) === "own";
}

export function planOwnStack(plan: AppPlan, input: PlanInput, cfg: ConfigRead | null): AppPlan {
  plan.kind = "own";
  const rootPaths = new Set(atRoot(input.paths));
  if (COMPOSE_NAMES.some((m) => rootPaths.has(m))) {
    runCompose(plan, input, cfg);
  } else if (rootPaths.has("Dockerfile")) {
    buildDockerfile(plan, cfg);
    resolveAddons(plan, input, cfg?.file ?? null, new Set(input.paths));
  } else {
    plan.reasons.push({
      level: "error",
      found: "no compose file or Dockerfile at the root",
      then: "choose a runtime to build it with instead",
    });
  }
  return plan;
}

function runCompose(plan: AppPlan, input: PlanInput, cfg: ConfigRead | null): void {
  plan.reasons.push({
    level: "info",
    found: "a compose file",
    then: "runs it as it is; x-gangway in it sets the preview's policy",
  });
  if (cfg)
    plan.reasons.push({
      level: "warn",
      found: cfg.name,
      then: "is ignored: the compose file is the whole configuration",
    });
  plan.issues = [];
  if ((input.addons?.length ?? 0) > 0)
    plan.reasons.push({
      level: "error",
      found: "add-ons with a compose file",
      then: "declare the database as a service in the compose file instead",
    });
}

function buildDockerfile(plan: AppPlan, cfg: ConfigRead | null): void {
  applySettings(plan, cfg?.file);
  plan.configFile = cfg?.name ?? null;
  plan.reasons.push({
    level: "info",
    found: "a Dockerfile",
    then: plan.port
      ? `builds it and routes to port ${plan.port}`
      : "builds it; say which port it listens on (`port:` in gangway.yml, or ?port=)",
  });
}
