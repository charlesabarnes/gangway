import type { Command, GangwayFile } from "../gangway-file.ts";
import type { Runtime } from "../runtimes.ts";
import { cmdText } from "./command-text.ts";
import type { Procfile } from "./procfile.ts";
import type { AppPlan, Reason, ReadFile } from "./types.ts";

export const STATIC_OUTPUTS = ["dist", "build", "out", ".output/public", "dist/*/browser"];

export type RuleContext = {
  plan: AppPlan;
  file: GangwayFile | null;
  have: Set<string>;
  text: ReadFile;
  rt: Runtime;
  procfile: Procfile | null;
};

export function startOverride({ plan, file, procfile }: RuleContext): Command | null {
  if (file?.start !== undefined) {
    plan.reasons.push({
      level: "info",
      found: "start: in gangway.yml",
      then: `runs \`${cmdText(file.start)}\``,
    });
    return file.start;
  }
  if (procfile?.["web"]) {
    plan.reasons.push({
      level: "info",
      found: "Procfile web:",
      then: `runs \`${procfile["web"]}\``,
    });
    return procfile["web"];
  }
  return null;
}

export function override<T>(v: T | false | undefined, fallback: T | null): T | null {
  if (v === false) return null;
  return v === undefined ? fallback : v;
}

export function ignored(ctx: RuleContext, keys: (keyof GangwayFile)[], why: string): void {
  const set = keys.filter((k) => ctx.file?.[k] !== undefined);
  if (set.length > 0)
    ctx.plan.reasons.push({
      level: "warn",
      found: `${set.join(", ")} in gangway.yml`,
      then: `ignored: ${why}`,
    });
}

export function serveBuilt({ plan, file }: RuleContext, why: string, reasonFound: string): void {
  const out = file?.static === undefined || file.static === true ? null : file.static;
  plan.serve = { kind: "static", output: out, fallback: "spa" };
  plan.start = null;
  plan.reasons.push({
    level: "info",
    found: reasonFound,
    then: `${why}serves ${out ? `${out}/` : `the build's output (${STATIC_OUTPUTS.slice(0, 3).join("/, ")}/ …)`} with nginx`,
  });
}

export const firstEntry = (have: Set<string>, rt: Runtime): string | null =>
  rt.entries.find((e) => have.has(e)) ?? null;

export const noEntry = (rt: Runtime, extra = ""): Reason => ({
  level: "error",
  found: `no entry file for ${rt.name}`,
  then: `the ${rt.name} runtime needs an entry file${extra}: one of ${rt.entries.join(", ")}`,
});
