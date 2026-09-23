import type { GangwayFile } from "../gangway-file.ts";
import { cmdText } from "./command-text.ts";
import type { AppPlan, ReadFile } from "./types.ts";

export type Procfile = Record<string, string>;

function parseProcfile(text: string): Procfile {
  const out: Procfile = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.+?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) out[m[1]!] = m[2]!;
  }
  return out;
}

export function applyProcfile(
  plan: AppPlan,
  file: GangwayFile | null,
  text: ReadFile,
): Procfile | null {
  const source = text("Procfile");
  const procfile = source !== undefined ? parseProcfile(source) : null;
  if (procfile) {
    const others = Object.keys(procfile).filter((k) => k !== "web" && k !== "release");
    if (others.length > 0)
      plan.reasons.push({
        level: "warn",
        found: `Procfile: ${others.join(", ")}`,
        then: "only `web` and `release` run in a preview",
      });
  }
  plan.release = file?.release ?? procfile?.["release"] ?? null;
  if (plan.release !== null)
    plan.reasons.push({
      level: "info",
      found: file?.release ? "release: in gangway.yml" : "Procfile release:",
      then: `runs \`${cmdText(plan.release)}\` before each version goes live`,
    });
  return procfile;
}
