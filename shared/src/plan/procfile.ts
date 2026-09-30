import { must } from "../must.ts";
import type { GangwayFile } from "../gangway-file.ts";
import { cmdText } from "./command-text.ts";
import { type AppPlan, type ReadFile, reason } from "./types.ts";

export type Procfile = Record<string, string>;

const LINE_BREAK = /[\n\r\u2028\u2029]/;

/** `name: command`, split as /^([A-Za-z0-9_-]+):\s*(.+?)\s*$/ split it, without its backtracking. */
function processLine(line: string): [name: string, command: string] | null {
  const m = /^([\w-]+):(.*)$/s.exec(line);
  if (!m) {
    return null;
  }
  const name = must(m[1], "a process name");
  const rest = m[2] ?? "";
  const command = rest.trim();
  if (command) {
    return LINE_BREAK.test(command) ? null : [name, command];
  }
  // Only spaces: the regex took the last one that is not a line break as the command.
  const last = [...rest].findLast((c) => !LINE_BREAK.test(c));
  return last === undefined ? null : [name, last];
}

function parseProcfile(text: string): Procfile {
  const out: Procfile = {};
  for (const line of text.split(/\r?\n/)) {
    const m = processLine(line);
    if (m && !line.trimStart().startsWith("#")) {
      out[m[0]] = m[1];
    }
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
    if (others.length > 0) {
      plan.reasons.push(
        reason(
          "warn",
          `Procfile: ${others.join(", ")}`,
          "only `web` and `release` run in a preview",
        ),
      );
    }
  }
  plan.release = file?.release ?? procfile?.["release"] ?? null;
  if (plan.release !== null) {
    plan.reasons.push(
      reason(
        "info",
        file?.release ? "release: in gangway.yml" : "Procfile release:",
        `runs \`${cmdText(plan.release)}\` before each version goes live`,
      ),
    );
  }
  return procfile;
}
