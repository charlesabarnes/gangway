/**
 * Teardown (§5 step 11): `docker compose -p <project> down -v`, routes removed.
 *
 * Addressed by PROJECT NAME ALONE, with no compose files. Verified against Compose
 * v2.29.2: a file-less `down -v --remove-orphans` removes the containers, the named
 * volumes and the network, found through the labels compose itself wrote. That matters
 * because scratch does not survive a restart (Workdirs.prune) and a compose file that no
 * longer parses must never be able to block a destroy.
 *
 * It runs from a fresh empty directory: given no `-f`, compose searches the cwd AND ITS
 * PARENTS for a compose.yaml, and this repository has one.
 *
 * Routes are removed only AFTER the daemon confirms. If `down` fails the containers may
 * still hold their ports, so the ledger must keep saying so.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host, Preview } from "../../../shared/src/domain.ts";
import { actorId, type Actor } from "../auth/actor.ts";
import { downArgv } from "../docker/compose.ts";
import { AppError, notFound } from "../errors.ts";
import { redactString } from "../logger.ts";
import type { PreviewContext } from "./context.ts";

export async function destroy(ctx: PreviewContext, previewId: string, actor: Actor): Promise<Preview> {
  const preview = ctx.previews.get(previewId);
  if (!preview || preview.state === "destroyed") throw notFound(`no such preview: ${previewId}`);
  if (preview.state === "destroying") throw new AppError("conflict", "this preview is already being destroyed");

  const host = ctx.hosts.get(preview.hostId);
  if (!host) throw new AppError("internal", `preview ${previewId} is on unknown host ${preview.hostId}`);

  // Claim it first (synchronously), so a second DELETE gets the 409 above.
  ctx.states.transition(previewId, "destroying");
  ctx.logs.append(previewId, "system", `destroying (requested by ${actorId(actor)})`);
  // The TTL sweep comes through here too, as `system:ttl-sweep`: "why did it vanish" has an answer.
  ctx.audit?.record(actor, "preview.destroy", previewId, { old: { project: preview.project, state: preview.state, hostId: preview.hostId } });
  return teardown(ctx, preview, host);
}

/**
 * The part of a destroy that happens after the preview is `destroying`. Separate so the
 * reconciler can FINISH a teardown that a restart interrupted: the row already says
 * `destroying`, nobody is coming back for it, and `down` is idempotent.
 */
export async function teardown(ctx: PreviewContext, preview: Preview, host: Host): Promise<Preview> {
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

  // Stop a deploy that is still running, and let it unwind before we `down`: otherwise
  // its `up` can recreate what we are removing.
  const running = ctx.inflight.get(previewId);
  if (running) {
    running.abort.abort();
    await running.done.catch(() => {});
  }

  const empty = await mkdtemp(join(tmpdir(), "gangway-down-"));
  try {
    const res = await ctx.compose.capture(downArgv({ project: preview.project, files: [], docker: ctx.docker }, [], rmiFor(preview)), host, { cwd: empty });
    if (res.code !== 0) throw new Error(`compose down exited ${res.code}: ${res.stderr.slice(-500)}`);
    await removeLeftovers(ctx, preview, host, empty);
  } catch (e) {
    const message = redactString(e instanceof Error ? e.message : String(e));
    ctx.logs.append(previewId, "system", `destroy FAILED: ${message}`);
    ctx.states.transition(previewId, "failed", `destroy failed: ${message}`);
    throw e instanceof AppError ? e : new AppError("bad_gateway", "the host could not tear the preview down; it is still there", { cause: message });
  } finally {
    await rm(empty, { recursive: true, force: true });
  }

  ctx.table.removePreview(previewId);
  const gone = ctx.states.transition(previewId, "destroyed");
  await ctx.workdirs.remove(previewId);
  await ctx.sources?.remove(previewId); // ADR-0015: the kept upload goes with it
  ctx.logs.remove(previewId); // §15.4 default: discard on destroy
  return gone;
}

/**
 * `all` only for an image pushed for this preview's commit (ADR-0014): unique to it, and
 * left behind by `local`. Anything else may be an image the operator's own containers share.
 */
export const rmiFor = (p: Preview): "local" | "all" => (p.source.kind === "pr" && p.source.image ? "all" : "local");

/**
 * A file-less `down -v` finds volumes through the project's CONTAINERS. After a failed
 * rebuild kept an add-on's volume and removed its containers (ADR-0017), there are none to
 * find it by -- so anything still labelled with the project goes by name: volumes, and
 * untagged images compose built for it. The label is compose's own, and the project name
 * is `gw-<instance>-...`: only ever ours.
 */
async function removeLeftovers(ctx: PreviewContext, preview: Preview, host: Host, cwd: string): Promise<void> {
  const docker = ctx.docker ?? "docker";
  const label = `label=com.docker.compose.project=${preview.project}`;
  const listed = async (argv: string[]) => {
    const res = await ctx.compose.capture(argv, host, { cwd });
    return res.code === 0 ? res.stdout.split("\n").map((l) => l.trim()).filter((l) => /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(l)) : [];
  };
  const volumes = await listed([docker, "volume", "ls", "--quiet", "--filter", label]);
  if (volumes.length > 0) {
    const rm = await ctx.compose.capture([docker, "volume", "rm", ...volumes], host, { cwd });
    if (rm.code !== 0) ctx.logger.warn("could not remove a destroyed preview's volumes", { previewId: preview.id, volumes, err: rm.stderr.slice(-300) });
  }
  // A rebuild that failed after `up` never got to remove the image it replaced; `--rmi local`
  // only takes TAGGED images. Untagged ones that compose built for this project are ours.
  const images = await listed([docker, "image", "ls", "--quiet", "--filter", "dangling=true", "--filter", label]);
  if (images.length > 0) {
    const rm = await ctx.compose.capture([docker, "image", "rm", ...new Set(images)], host, { cwd });
    if (rm.code !== 0) ctx.logger.warn("could not remove a destroyed preview's untagged images", { previewId: preview.id, images, err: rm.stderr.slice(-300) });
  }
}

/**
 * Best-effort `down` for a stack nobody is going to finish starting. Never throws: the
 * caller has already decided the preview's fate, and this only returns its resources.
 */
export async function releaseStack(ctx: PreviewContext, preview: Preview, host: Host): Promise<boolean> {
  const empty = await mkdtemp(join(tmpdir(), "gangway-down-"));
  try {
    // Containers and ports, not data (ADR-0017): the preview still exists, and its add-on's volume with it.
    const res = await ctx.compose.capture(downArgv({ project: preview.project, files: [], docker: ctx.docker }, [], rmiFor(preview), { volumes: false }), host, { cwd: empty });
    return res.code === 0;
  } catch {
    return false;
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
}
