import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host, Preview } from "@gangway/shared/domain";
import { actorId, type Actor } from "../auth/actor.ts";
import { downArgv } from "../docker/compose.ts";
import { AppError, notFound, errorMessage } from "../errors.ts";
import { redactString } from "../logger.ts";
import type { PreviewContext } from "./context.ts";

export async function destroy(
  ctx: PreviewContext,
  previewId: string,
  actor: Actor,
): Promise<Preview> {
  const preview = ctx.previews.get(previewId);
  if (!preview || preview.state === "destroyed") throw notFound(`no such preview: ${previewId}`);
  if (preview.state === "destroying")
    throw new AppError("conflict", "this preview is already being destroyed");

  const host = ctx.hosts.get(preview.hostId);
  if (!host)
    throw new AppError("internal", `preview ${previewId} is on unknown host ${preview.hostId}`);

  ctx.states.transition(previewId, "destroying");
  ctx.logs.append(previewId, "system", `destroying (requested by ${actorId(actor)})`);
  ctx.audit.record(actor, "preview.destroy", previewId, {
    old: { project: preview.project, state: preview.state, hostId: preview.hostId },
  });
  return teardown(ctx, preview, host);
}

export async function teardown(
  ctx: PreviewContext,
  preview: Preview,
  host: Host,
): Promise<Preview> {
  const previewId = preview.id;
  ctx.teardowns.add(previewId);
  try {
    return await teardownInner(ctx, preview, host);
  } finally {
    ctx.teardowns.delete(previewId);
  }
}

async function teardownInner(ctx: PreviewContext, preview: Preview, host: Host): Promise<Preview> {
  const previewId = preview.id;

  // Let a running deploy unwind first, or its up can recreate what down removes.
  const running = ctx.inflight.get(previewId);
  if (running) {
    running.abort.abort();
    await running.done.catch(() => {});
  }

  // Without -f, compose searches the cwd and its parents for a compose file.
  const empty = await mkdtemp(join(tmpdir(), "gangway-down-"));
  try {
    const res = await ctx.compose.capture(
      downArgv({ project: preview.project, files: [], docker: ctx.docker }, [], rmiFor(preview)),
      host,
      { cwd: empty },
    );
    if (res.code !== 0)
      throw new Error(`compose down exited ${res.code}: ${res.stderr.slice(-500)}`);
    await removeLeftovers(ctx, preview, host, empty);
  } catch (e) {
    const message = redactString(errorMessage(e));
    ctx.logs.append(previewId, "system", `destroy FAILED: ${message}`);
    ctx.states.transition(previewId, "failed", `destroy failed: ${message}`);
    throw e instanceof AppError
      ? e
      : new AppError("bad_gateway", "the host could not tear the preview down; it is still there", {
          cause: message,
        });
  } finally {
    await rm(empty, { recursive: true, force: true });
  }

  ctx.table.removePreview(previewId);
  const gone = ctx.states.transition(previewId, "destroyed");
  await ctx.workdirs.remove(previewId);
  await ctx.sources?.remove(previewId);
  ctx.logs.remove(previewId);
  return gone;
}

export const rmiFor = (p: Preview): "local" | "all" =>
  p.source.kind === "pr" && p.source.image ? "all" : "local";

async function removeLeftovers(
  ctx: PreviewContext,
  preview: Preview,
  host: Host,
  cwd: string,
): Promise<void> {
  const docker = ctx.docker ?? "docker";
  const label = `label=com.docker.compose.project=${preview.project}`;
  const listed = async (argv: string[]) => {
    const res = await ctx.compose.capture(argv, host, { cwd });
    return res.code === 0
      ? res.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(l))
      : [];
  };
  const volumes = await listed([docker, "volume", "ls", "--quiet", "--filter", label]);
  if (volumes.length > 0) {
    const rm = await ctx.compose.capture([docker, "volume", "rm", ...volumes], host, { cwd });
    if (rm.code !== 0)
      ctx.logger.warn("could not remove a destroyed preview's volumes", {
        previewId: preview.id,
        volumes,
        err: rm.stderr.slice(-300),
      });
  }
  const images = await listed([
    docker,
    "image",
    "ls",
    "--quiet",
    "--filter",
    "dangling=true",
    "--filter",
    label,
  ]);
  if (images.length > 0) {
    const rm = await ctx.compose.capture([docker, "image", "rm", ...new Set(images)], host, {
      cwd,
    });
    if (rm.code !== 0)
      ctx.logger.warn("could not remove a destroyed preview's untagged images", {
        previewId: preview.id,
        images,
        err: rm.stderr.slice(-300),
      });
  }
}

export async function releaseStack(
  ctx: PreviewContext,
  preview: Preview,
  host: Host,
): Promise<boolean> {
  const empty = await mkdtemp(join(tmpdir(), "gangway-down-"));
  try {
    const res = await ctx.compose.capture(
      downArgv({ project: preview.project, files: [], docker: ctx.docker }, [], rmiFor(preview), {
        volumes: false,
      }),
      host,
      { cwd: empty },
    );
    return res.code === 0;
  } catch {
    return false;
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
}
