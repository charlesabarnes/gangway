import type { Preview } from "@gangway/shared/domain";
import { cmdText, type AppPlan } from "@gangway/shared/app-plan";
import type { PreviewContext } from "../previews/context.ts";
import { urlsFor } from "../previews/deploy.ts";
import { nameOf } from "./resolve.ts";
import { isLocalDomain } from "@gangway/shared/hostname";

const PLAN_REASONS_SHOWN = 8;

function inTime(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) {
    return `${Math.max(1, m)}m`;
  }
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export function describePreview(ctx: PreviewContext, p: Preview): string {
  const urls = urlsFor(ctx, p.id).map((u) => u.url);
  const parts = [`${nameOf(ctx, p)}: ${p.state}`];
  if (p.title) {
    parts.push(`"${p.title}"`);
  }
  if (p.icon) {
    parts.push(`icon ${p.icon.name} (${p.icon.color})`);
  }
  if (urls.length > 0) {
    parts.push(urls.join(" "));
  }
  if (p.state === "asleep") {
    parts.push("(wakes on the first visit)");
  }
  if (p.ttlExpiresAt !== null) {
    parts.push(`expires in ${inTime(p.ttlExpiresAt.getTime() - ctx.now())}`);
  }
  if (p.state === "failed" && p.error) {
    parts.push(`error: ${p.error}`);
  }
  const moving = movingTo(ctx, p);
  if (moving) {
    parts.push(`moves to ${moving} on its next rebuild`);
  }
  return parts.join(" — ");
}

/**
 * On a local-only install its URL works only where gangway runs, which an agent cannot tell from
 * the URL; the share tool is the way to show it to anyone else.
 */
export function localNote(ctx: PreviewContext, p: Preview): string {
  const control = ctx.domains?.control();
  if (!control || !isLocalDomain(control) || ctx.shares?.get(p.id)) {
    return "";
  }
  const how = ctx.shares?.available()
    ? `; the share tool gives it a public link (ask the user first)`
    : "";
  return `\nThis URL works only on the machine gangway runs on${how}.`;
}

/** The domain it will be named under once rebuilt, when that is not where it is now. */
function movingTo(ctx: PreviewContext, p: Preview): string | null {
  const now = ctx.table.forPreview(p.id)[0]?.hostname;
  const next = ctx.domains?.domainOf(p);
  return now && next && !now.endsWith(`.${next}`) ? next : null;
}

const listOf = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

function reasonLines(detail: Record<string, unknown>): string[] {
  return listOf<{ level?: string; found?: string; then?: string }>(detail["reasons"])
    .filter((r) => r.found && r.then)
    .map((r) => `  ${r.level && r.level !== "info" ? `${r.level}: ` : ""}${r.found} -> ${r.then}`);
}

function issueLines(detail: Record<string, unknown>): string[] {
  return listOf<{ path?: string; message?: string }>(detail["issues"])
    .filter((i) => i.message)
    .map((i) => `  gangway.yml ${i.path ?? ""}: ${i.message}`);
}

function violationLines(detail: Record<string, unknown>): string[] {
  return listOf<unknown>(detail["violations"]).map(
    (v) => `  ${typeof v === "string" ? v : JSON.stringify(v)}`,
  );
}

export function refusalDetail(detail: Record<string, unknown> | undefined): string {
  if (!detail) {
    return "";
  }
  const lines = [...reasonLines(detail), ...issueLines(detail), ...violationLines(detail)];
  if (typeof detail["compose"] === "string") {
    lines.push(`  compose: ${detail["compose"].slice(-500)}`);
  }
  return lines.length ? `\n${lines.slice(0, 20).join("\n")}` : "";
}

function planRuns(plan: AppPlan, served: boolean): string | null {
  if (plan.kind === "own") {
    return null;
  }
  if (plan.start) {
    return `runs \`${cmdText(plan.start)}\``;
  }
  if (plan.entry) {
    return `runs ${plan.entry}`;
  }
  if (served) {
    return "gangway serves the files itself, with no container";
  }
  return plan.serve.kind === "static" ? "the files are served by nginx" : null;
}

export function describePlan(plan: AppPlan, served = false): string {
  const what =
    plan.kind === "own"
      ? "the upload's own compose file or Dockerfile"
      : `${plan.runtime}${plan.version ? ` ${plan.version}` : ""}`;
  const addons = plan.addons.length
    ? `add-ons: ${plan.addons.map((a) => `${a.id} ${a.version}`).join(", ")}`
    : null;
  const reasons = plan.reasons
    .slice(0, PLAN_REASONS_SHOWN)
    .map((r) => `  ${r.level === "info" ? "" : `${r.level}: `}${r.found} -> ${r.then}`);
  const more =
    plan.reasons.length > PLAN_REASONS_SHOWN
      ? [`  … ${plan.reasons.length - PLAN_REASONS_SHOWN} more in logs`]
      : [];
  return [
    `plan: ${[what, planRuns(plan, served), addons].filter(Boolean).join(" — ")}`,
    ...reasons,
    ...more,
  ].join("\n");
}

export function logTail(ctx: PreviewContext, id: string, n: number): string {
  const lines = ctx.logs.read(id).slice(-n);
  return lines.length === 0
    ? "(no log lines yet)"
    : lines.map((l) => `${l.stream}: ${l.line}`).join("\n");
}
