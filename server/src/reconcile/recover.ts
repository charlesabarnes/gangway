import { servedByGangway, type Host, type Preview } from "@gangway/shared/domain";
import type { RoutesRepo } from "../db/repos/routes.ts";
import type { PreviewContext } from "../previews/context.ts";
import { releaseStack, teardown } from "../previews/destroy.ts";
import type { Action } from "./diff.ts";

export type Recovery = {
  ctx: PreviewContext;
  routes: RoutesRepo;
  covered: ReadonlySet<string>;
  reachable: ReadonlyMap<string, boolean>;
  hosts: ReadonlyMap<string, Host>;
};

export function isBusy(ctx: PreviewContext, previewId: string): boolean {
  return ctx.inflight.has(previewId) || ctx.teardowns.has(previewId);
}

export function coveredHostnames(actions: readonly Action[]): Set<string> {
  const covered = new Set<string>();
  for (const a of actions) {
    if (
      a.kind === "UpdateUpstream" ||
      (a.kind === "LeaveAlone" && a.reason === "in-sync" && a.hostname)
    )
      covered.add(a.hostname!);
  }
  return covered;
}

function hostFor(r: Recovery, p: Preview): Host | undefined {
  const host = r.hosts.get(p.hostId);
  if (!host || !r.reachable.get(p.hostId) || isBusy(r.ctx, p.id)) return undefined;
  return host;
}

async function answering(r: Recovery, p: Preview, host: Host): Promise<boolean> {
  const mine = r.routes.forPreview(p.id);
  if (mine.length === 0 || !mine.every((route) => r.covered.has(route.hostname))) return false;
  return (await Promise.all(mine.map((route) => r.ctx.probe(route, host)))).every(Boolean);
}

export async function rescueInterrupted(r: Recovery): Promise<string[]> {
  const { ctx } = r;
  const out: string[] = [];
  for (const p of ctx.previews.list({ state: ["building", "starting", "destroying"] })) {
    // The diff settles an interrupted served preview; it has no container to probe.
    if (servedByGangway(p) && p.state !== "destroying") continue;
    const host = hostFor(r, p);
    if (!host) continue;

    if (p.state === "destroying") {
      out.push(await resumeTeardown(ctx, p, host));
      continue;
    }

    const up = await answering(r, p, host);
    if (isBusy(ctx, p.id) || ctx.previews.get(p.id)?.state !== p.state) continue;
    out.push(up ? markInterruptedAwake(ctx, p) : await failInterrupted(ctx, p, host));
  }
  return out;
}

async function resumeTeardown(ctx: PreviewContext, p: Preview, host: Host): Promise<string> {
  ctx.logs.append(p.id, "system", "resuming a teardown interrupted by a restart");
  const done = await teardown(ctx, p, host).then(
    () => true,
    () => false,
  );
  return `${p.project}: interrupted teardown ${done ? "finished" : "failed again"}`;
}

function markInterruptedAwake(ctx: PreviewContext, p: Preview): string {
  if (p.state === "building") ctx.states.transition(p.id, "starting");
  ctx.states.transition(p.id, "awake");
  ctx.logs.append(
    p.id,
    "system",
    "awake (the stack came up; the restart only interrupted the bookkeeping)",
  );
  return `${p.project}: interrupted while ${p.state}, but the stack is up and answering; marked awake`;
}

async function failInterrupted(ctx: PreviewContext, p: Preview, host: Host): Promise<string> {
  const error = `interrupted by a server restart while ${p.state}`;
  ctx.states.transition(p.id, "failed", error);
  ctx.logs.append(p.id, "system", `FAILED: ${error}`);
  const released = await releaseStack(ctx, p, host);
  return `${p.project}: ${error}${released ? "; stack released" : ""}`;
}

export async function wakeReturned(r: Recovery): Promise<string[]> {
  const { ctx } = r;
  const out: string[] = [];
  for (const p of ctx.previews.list({ state: ["asleep"] })) {
    const host = hostFor(r, p);
    if (!host) continue;
    const up = await answering(r, p, host);
    if (!up || isBusy(ctx, p.id) || ctx.previews.get(p.id)?.state !== "asleep") continue;
    ctx.states.transition(p.id, "starting");
    ctx.states.transition(p.id, "awake");
    ctx.logs.append(
      p.id,
      "system",
      "awake (its containers were started outside gangway and are answering)",
    );
    out.push(`${p.project}: asleep, but its containers are running and answering; marked awake`);
  }
  return out;
}
