import { must } from "../must.ts";
import type { GangwayFile } from "../gangway-file.ts";
import {
  DETECTION,
  detectRuntime,
  runtimeById,
  type Runtime,
  type RuntimeId,
} from "../runtimes.ts";
import type { Scope } from "./root.ts";
import type { AppPlan, PlanChoice, PlanInput, Reason } from "./types.ts";

type Asked = { choice: Exclude<PlanChoice, "own">; file: GangwayFile | null };

export function chooseRuntime(
  input: PlanInput,
  { choice, file }: Asked,
  scope: Scope,
  reasons: Reason[],
): RuntimeId {
  if (choice !== "auto") {
    if (file?.runtime && file.runtime !== choice) {
      reasons.push({
        level: "info",
        found: `gangway.yml says ${file.runtime}`,
        then: `building as ${runtimeById(choice).name}, as asked`,
      });
    }
    return choice;
  }
  if (file?.runtime) {
    reasons.push({
      level: "info",
      found: `runtime: ${file.runtime}`,
      then: `builds it as ${runtimeById(file.runtime).name}`,
    });
    return file.runtime;
  }
  if (input.previous !== undefined && input.previous !== "own") {
    reasons.push({
      level: "info",
      found: "the previous build",
      then: `builds it as ${runtimeById(input.previous).name} again`,
    });
    return input.previous;
  }
  return detectFromMarkers(scope, reasons);
}

function detectFromMarkers(scope: Scope, reasons: Reason[]): RuntimeId {
  const d = detectRuntime(scope.paths);
  const runtime = d === "own" ? "static" : d;
  const marker = DETECTION.filter((r) => r.runtime === runtime)
    .flatMap((r) => r.markers)
    .find((m) => scope.have.has(m));
  reasons.push({
    level: "info",
    found: marker ?? "no marker file",
    then: `looks like ${runtimeById(runtime).name}`,
  });
  return runtime;
}

export function pickVersion(plan: AppPlan, rt: Runtime, file: GangwayFile | null): boolean {
  const versions = Object.keys(rt.versions);
  plan.version =
    versions.find((v) => rt.versions[v] === rt.image) ??
    must(versions[0], `a version of ${rt.name}`);
  if (file?.version !== undefined) {
    if (rt.versions[file.version] === undefined) {
      plan.issues.push({
        path: "version",
        message: `${rt.name} offers ${Object.keys(rt.versions).join(", ")}`,
      });
      return false;
    }
    plan.version = file.version;
  }
  plan.image = must(rt.versions[plan.version], `the ${rt.name} ${plan.version} image`);
  return true;
}
