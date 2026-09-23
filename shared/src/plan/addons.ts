import type { GangwayFile } from "../gangway-file.ts";
import { ADDONS, addonById, isSql, type AddonChoice } from "../addons.ts";
import type { AddonRequest, AppPlan, PlanInput, ReadFile } from "./types.ts";

export function resolveAddons(
  plan: AppPlan,
  input: PlanInput,
  file: GangwayFile | null,
  have: Set<string>,
): void {
  const asked = input.addons ?? file?.addons ?? input.previousAddons;
  const from = askedFrom(input, file);
  const out: AddonChoice[] = [];
  for (const req of asked ?? []) {
    const choice = checkAddon(plan, input, file, req);
    if (!choice) continue;
    out.push(choice);
    const a = addonById(choice.id);
    plan.reasons.push({
      level: "info",
      found: `${a.name} ${choice.version} (${from})`,
      then: `a throwaway database beside the app; ${a.env[0]} in its environment; gone when the preview is`,
    });
  }
  if (asked !== input.previousAddons) warnRemoved(plan, input, out);
  plan.addons = out;
  findSqlSeed(plan, out, have);
}

function askedFrom(input: PlanInput, file: GangwayFile | null): string {
  if (input.addons !== undefined) return "asked for";
  return file?.addons !== undefined ? "addons: in gangway.yml" : "the previous build";
}

function checkAddon(
  plan: AppPlan,
  input: PlanInput,
  file: GangwayFile | null,
  req: AddonRequest,
): AddonChoice | null {
  const id = typeof req === "string" ? req : req.id;
  const a = addonById(id);
  const prev = input.previousAddons?.find((p) => p.id === id);
  const wanted = typeof req === "string" ? undefined : req.version;
  const version = wanted ?? prev?.version ?? a.defaultVersion;
  if (a.versions[version] === undefined) {
    const offers = `${a.name} offers ${Object.keys(a.versions).join(", ")}`;
    if (file?.addons !== undefined && input.addons === undefined)
      plan.issues.push({ path: "addons", message: offers });
    else plan.reasons.push({ level: "error", found: `${a.name} ${version}`, then: offers });
    return null;
  }
  if (prev && prev.version !== version) {
    plan.reasons.push({
      level: "error",
      found: `${a.name} ${prev.version} -> ${version}`,
      then: "a new major version needs a new preview: its data directory would not start",
    });
    return null;
  }
  return { id, version };
}

function warnRemoved(plan: AppPlan, input: PlanInput, kept: AddonChoice[]): void {
  for (const p of input.previousAddons ?? []) {
    if (!kept.some((o) => o.id === p.id)) {
      plan.reasons.push({
        level: "warn",
        found: `${addonById(p.id).name} removed`,
        then: "its container goes; its data is kept until the preview is destroyed, and comes back if you add it again",
      });
    }
  }
}

function findSqlSeed(plan: AppPlan, chosen: AddonChoice[], have: Set<string>): void {
  const sql = chosen.find((a) => isSql(a.id));
  if (!sql) return;
  plan.sqlSeed = addonById(sql.id).seedFiles.find((f) => have.has(f)) ?? null;
  if (plan.sqlSeed)
    plan.reasons.push({
      level: "info",
      found: plan.sqlSeed,
      then: `loaded into ${addonById(sql.id).name} on its first start only; later edits do not re-run it`,
    });
}

export function suggestAddons(plan: AppPlan, text: ReadFile): void {
  const npm = npmDependencies(text("package.json"));
  const pip = pipDependencies(text);
  const composer = composerDependencies(text("composer.json"));
  for (const a of ADDONS) {
    if (plan.addons.some((c) => c.id === a.id)) continue;
    const hit =
      a.hints.npm.find((d) => npm.has(d)) ??
      a.hints.pip.find((d) => pip.has(d)) ??
      a.hints.composer.find((d) => composer.has(d));
    if (hit) plan.suggested.push({ id: a.id, because: hit });
  }
}

function npmDependencies(pkgText: string | undefined): Set<string> {
  const npm = new Set<string>();
  if (!pkgText) return npm;
  try {
    const pkg = JSON.parse(pkgText) as Record<string, unknown>;
    for (const k of ["dependencies", "devDependencies"])
      for (const d of Object.keys(pkg[k] ?? {})) npm.add(d);
  } catch {
    // the runtime's own read reports it
  }
  return npm;
}

function pipDependencies(text: ReadFile): Set<string> {
  const pip = new Set<string>();
  for (const line of [text("requirements.txt") ?? "", text("pyproject.toml") ?? ""]
    .join("\n")
    .split("\n")) {
    const m = /^\s*"?([A-Za-z0-9_.-]+)/.exec(line);
    if (m) pip.add(m[1]!.toLowerCase());
  }
  return pip;
}

function composerDependencies(composerText: string | undefined): Set<string> {
  const composer = new Set<string>();
  try {
    for (const d of Object.keys(
      (JSON.parse(composerText ?? "{}") as Record<string, unknown>)["require"] ?? {},
    ))
      composer.add(d);
  } catch {
    // unreadable composer.json: no suggestions from it
  }
  return composer;
}
