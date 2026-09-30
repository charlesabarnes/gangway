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
import { type AppPlan, type PlanChoice, type PlanInput, reason, type Reason } from "./types.ts";

type Asked = { choice: Exclude<PlanChoice, "own">; file: GangwayFile | null };

export function chooseRuntime(
  input: PlanInput,
  { choice, file }: Asked,
  scope: Scope,
  reasons: Reason[],
): RuntimeId {
  if (choice !== "auto") {
    if (file?.runtime && file.runtime !== choice) {
      reasons.push(
        reason(
          "info",
          `gangway.yml says ${file.runtime}`,
          `building as ${runtimeById(choice).name}, as asked`,
        ),
      );
    }
    return choice;
  }
  if (file?.runtime) {
    reasons.push(
      reason("info", `runtime: ${file.runtime}`, `builds it as ${runtimeById(file.runtime).name}`),
    );
    return file.runtime;
  }
  if (input.previous !== undefined && input.previous !== "own") {
    reasons.push(
      reason(
        "info",
        "the previous build",
        `builds it as ${runtimeById(input.previous).name} again`,
      ),
    );
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
  reasons.push(
    reason("info", marker ?? "no marker file", `looks like ${runtimeById(runtime).name}`),
  );
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
