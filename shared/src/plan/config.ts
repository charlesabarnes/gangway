import { GANGWAY_FILES, parseGangwayFile, type GangwayFile } from "../gangway-file.ts";
import type { AppPlan, PlanInput } from "./types.ts";

export const MAX_PLAN_FILE_BYTES = 256 * 1024;

export type ConfigRead = { name: string; file: GangwayFile | null };

export function readConfig(plan: AppPlan, input: PlanInput, dir: string): ConfigRead | null {
  const at = (n: string) => (dir ? `${dir}/${n}` : n);
  const present = GANGWAY_FILES.filter((n) => input.paths.includes(at(n)));
  if (present.length === 0) return null;
  if (present.length > 1) {
    plan.issues.push({
      path: "",
      message: "both gangway.yml and gangway.yaml are present; keep one",
    });
    return { name: at(present[0]!), file: null };
  }
  const name = at(present[0]!);
  const text = input.files[name];
  if (text === undefined) {
    plan.issues.push({
      path: "",
      message: `${name} could not be read (larger than ${MAX_PLAN_FILE_BYTES / 1024} KiB?)`,
    });
    return { name, file: null };
  }
  const parsed = parseGangwayFile(text);
  if (!parsed.ok) {
    plan.issues.push(...parsed.issues);
    return { name, file: null };
  }
  return { name, file: parsed.file };
}

export function applySettings(plan: AppPlan, file: GangwayFile | null | undefined): void {
  plan.port = file?.port ?? null;
  plan.env = file?.env ?? {};
  plan.health = file?.healthcheck ?? null;
  plan.stack = stackOf(file);
}

function stackOf(file: GangwayFile | null | undefined): AppPlan["stack"] {
  if (!file) return {};
  return {
    ...(file.ttl !== undefined ? { ttl: file.ttl } : {}),
    ...(file.visibility !== undefined ? { visibility: file.visibility } : {}),
    ...(file.idle !== undefined ? { idle: file.idle } : {}),
    ...(file.seed !== undefined ? { seed: file.seed } : {}),
  };
}
