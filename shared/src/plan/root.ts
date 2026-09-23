import { GANGWAY_FILES } from "../gangway-file.ts";
import { DETECTION } from "../runtimes.ts";
import { readConfig, type ConfigRead } from "./config.ts";
import type { AppPlan, PlanInput, ReadFile } from "./types.ts";

const APP_MARKERS = new Set([
  ...DETECTION.filter((r) => r.runtime !== "own").flatMap((r) => r.markers),
  ...GANGWAY_FILES,
  "index.html",
  "Procfile",
]);

function nestedRoot(paths: readonly string[]): string | null {
  if (paths.some((p) => !p.includes("/") && APP_MARKERS.has(p))) return null;
  const dirs = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    if (parts.length === 2 && APP_MARKERS.has(parts[1]!)) dirs.add(parts[0]!);
  }
  return dirs.size === 1 ? [...dirs][0]! : null;
}

export function useExplicitRoot(plan: AppPlan, input: PlanInput, root: string): boolean {
  if (!input.paths.some((p) => p.startsWith(`${root}/`))) {
    plan.issues.push({ path: "root", message: `${root}/ is not a directory in the upload` });
    return false;
  }
  plan.root = root;
  plan.reasons.push({ level: "info", found: `root: ${root}`, then: `builds ${root}/ as the app` });
  return true;
}

export function useNestedRoot(plan: AppPlan, input: PlanInput): ConfigRead | null {
  const nested = nestedRoot(input.paths);
  if (!nested) return null;
  plan.root = nested;
  plan.reasons.push({
    level: "info",
    found: `the app is in ${nested}/`,
    then: `builds ${nested}/ (set \`root:\` in gangway.yml to choose another)`,
  });
  return readConfig(plan, input, nested);
}

export type Scope = { paths: string[]; have: Set<string>; text: ReadFile };

export function scopeToRoot(input: PlanInput, root: string): Scope {
  const paths = root
    ? input.paths.filter((p) => p.startsWith(`${root}/`)).map((p) => p.slice(root.length + 1))
    : [...input.paths];
  const at = (n: string) => (root ? `${root}/${n}` : n);
  return { paths, have: new Set(paths), text: (n) => input.files[at(n)] };
}

export function warnNestedContainerFiles(plan: AppPlan, have: Set<string>): void {
  if (plan.root && (have.has("Dockerfile") || DETECTION[0]!.markers.some((m) => have.has(m)))) {
    plan.reasons.push({
      level: "warn",
      found: `${plan.root}/ has a Dockerfile or compose file`,
      then: "gangway uses those only at the upload's root; building with a runtime instead",
    });
  }
}
