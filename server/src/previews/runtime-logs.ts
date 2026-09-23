/**
 * What a preview's containers are printing. The preview log (logs.ts) holds the pipeline --
 * build output, compose, gangway's own lines -- and a failed stack's last words, but not a
 * healthy stack's stdout. This reads that on demand with `compose logs`, which the daemon
 * keeps for as long as the containers exist (a sleeping preview's too).
 *
 * Read, never stored: copying it would grow without bound on a chatty app. It is scrubbed
 * like every stored line -- redacted, and add-on passwords masked -- because an app printing
 * its DATABASE_URL is the common case.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Preview } from "@gangway/shared/domain";
import { composeArgv } from "../docker/compose.ts";
import { redactString } from "../logger.ts";
import type { PreviewContext } from "./context.ts";

/** States with containers to read: a stopped (asleep) container still has its log. */
const HAS_CONTAINERS: ReadonlySet<Preview["state"]> = new Set(["starting", "awake", "asleep"]);

export type RuntimeLogs = { lines: string[] } | { lines: null; why: string };

/** A compose service name: what `service` may be, since it becomes an argv element. */
const SERVICE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

export async function runtimeLogs(
  ctx: PreviewContext,
  p: Preview,
  opts: { tail: number; service?: string | undefined },
): Promise<RuntimeLogs> {
  if (!HAS_CONTAINERS.has(p.state))
    return { lines: null, why: `the preview is ${p.state}; it has no containers to read` };
  if (opts.service !== undefined && !SERVICE.test(opts.service))
    return { lines: null, why: `${JSON.stringify(opts.service)} is not a service name` };
  const host = ctx.hosts.get(p.hostId);
  if (!host) return { lines: null, why: `the preview is on an unknown host (${p.hostId})` };

  const masks = addonPasswords(ctx, p);
  const empty = await mkdtemp(join(tmpdir(), "gangway-runtime-logs-"));
  try {
    const args = [
      "--no-color",
      "--tail",
      String(Math.max(1, Math.min(500, opts.tail))),
      ...(opts.service ? [opts.service] : []),
    ];
    const r = await ctx.compose.capture(
      composeArgv({ project: p.project, files: [], command: "logs", args, docker: ctx.docker }),
      host,
      { cwd: empty },
    );
    if (r.code !== 0)
      return {
        lines: null,
        why: `compose logs exited ${r.code}: ${redactString(r.stderr).trim().slice(-300)}`,
      };
    const lines = r.stdout
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "")
      .map((l) => {
        let out = l;
        for (const m of masks) out = out.split(m).join("[redacted]");
        return redactString(out);
      });
    return { lines };
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
}

/**
 * Derived, not remembered (logs.ts forgets its masks on a restart): the same key gives the
 * same password.
 */
function addonPasswords(ctx: PreviewContext, p: Preview): string[] {
  if (p.source.kind !== "tarball" || !p.source.addons?.length || !ctx.addonSecret) return [];
  return p.source.addons.map((a) => ctx.addonSecret!(p.id, a.id)).filter((s) => s.length >= 8);
}
