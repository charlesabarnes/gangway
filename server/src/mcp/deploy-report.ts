import { servedByGangway, type Preview } from "@gangway/shared/domain";
import type { AppPlan } from "@gangway/shared/app-plan";
import { serveSite } from "../net/site.ts";
import { renderDist } from "../previews/artifact-render.ts";
import type { PreviewContext } from "../previews/context.ts";
import { CHECK_PATH, httpStatus } from "../previews/probe.ts";
import { describePlan } from "./describe.ts";

const MANIFEST_SHOWN = 40;

// What a deploy reports once it is up: the plan, the files as deployed, and the paths checked.
export async function deployReport(
  ctx: PreviewContext,
  p: Preview,
  plan: AppPlan | undefined,
  check: readonly string[] | undefined,
): Promise<string> {
  const out: string[] = [];
  if (plan) {
    out.push(describePlan(plan, servedByGangway(p)));
  }
  const manifest = await manifestOf(ctx, p);
  if (manifest) {
    out.push(manifest);
  }
  if (check && check.length > 0) {
    const checked = await checkPaths(ctx, p, check);
    if (checked) {
      out.push(checked);
    }
  }
  return out.length === 0 ? "" : `\n${out.join("\n")}`;
}

async function manifestOf(ctx: PreviewContext, p: Preview): Promise<string | null> {
  if (!ctx.sources || p.source.kind !== "tarball" || !(await ctx.sources.has(p.id))) {
    return null;
  }
  const m = await ctx.sources.manifest(p.id);
  if (m.files.length > MANIFEST_SHOWN) {
    return `files as deployed: ${m.files.length}${m.truncated ? "+" : ""} (too many to list; the preview page shows them)`;
  }
  const rows = m.files.map(
    (f) => `  ${f.sha256.slice(0, 12)}  ${String(f.bytes).padStart(8)}  ${f.path}`,
  );
  return `files as deployed (sha256, first 12 hex; compare with shasum -a 256):\n${rows.join("\n")}`;
}

async function checkPaths(
  ctx: PreviewContext,
  p: Preview,
  check: readonly string[],
): Promise<string | null> {
  const route = ctx.table.forPreview(p.id).find((e) => e.primary) ?? ctx.table.forPreview(p.id)[0];
  const host = ctx.hosts.get(p.hostId);
  if (!route || !host) {
    return null;
  }
  if (route.site) {
    return checkSite(ctx, p, { hostname: route.hostname, check });
  }
  const probe = ctx.statusProbe ?? httpStatus;
  const target = {
    hostname: route.hostname,
    upstream: { host: route.upstreamHost, port: route.upstreamPort },
  };
  const got = await Promise.all(
    check.map(async (path) => ({ path, status: await probe(target, host, path) })),
  );
  return checkedLine(got);
}

/**
 * The statuses on one line, then a warning for each server error: a preview counts as up once
 * it answers short of one on `/` or its health path, so a 500 on another path must not read as fine.
 */
function checkedLine(got: readonly { path: string; status: number | null }[]): string {
  const line = `checked: ${got.map((g) => `${g.path} ${g.status ?? "no answer"}`).join(" · ")}`;
  const failing = got.filter((g) => g.status === null || g.status >= 500);
  if (failing.length === 0) {
    return line;
  }
  const what = failing
    .map((g) => (g.status === null ? `${g.path} did not answer` : `${g.path} answered ${g.status}`))
    .join(", ");
  return `${line}\nWARNING: ${what}. The deploy is up, but that is not working: read logs with source: "runtime".`;
}

// The same answer a visitor gets past the password gate, without a trip through the network.
async function checkSite(
  ctx: PreviewContext,
  p: Preview,
  { hostname, check }: { hostname: string; check: readonly string[] },
): Promise<string | null> {
  const site = await ctx.sites?.open(p.id);
  if (!site) {
    return "checked: the preview's files are missing";
  }
  const got = await Promise.all(
    check.map(async (path) => {
      if (!CHECK_PATH.test(path)) {
        return { path, status: null };
      }
      const req = new Request(`https://${hostname}${path}`, { method: "GET" });
      const res = await serveSite(req, site, { unlisted: false, kitDir: renderDist() });
      await res.body?.cancel();
      return { path, status: res.status };
    }),
  );
  return checkedLine(got);
}
