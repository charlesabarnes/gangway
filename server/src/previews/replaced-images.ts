import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host } from "@gangway/shared/domain";
import { composeArgv } from "../docker/compose.ts";
import type { PreviewContext } from "./context.ts";
import type { ComposeBase } from "./pipeline.ts";

export async function imageIds(
  ctx: PreviewContext,
  host: Host,
  base: ComposeBase,
  cwd: string,
): Promise<Set<string>> {
  try {
    const res = await ctx.compose.capture(
      composeArgv({ ...base, command: "images", args: ["--quiet"] }),
      host,
      { cwd },
    );
    return new Set(
      res.code === 0
        ? res.stdout
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => /^(sha256:)?[0-9a-f]{12,64}$/.test(l))
        : [],
    );
  } catch {
    return new Set();
  }
}

export async function removeReplaced(
  ctx: PreviewContext,
  host: Host,
  base: ComposeBase,
  cwd: string,
  before: Set<string>,
  previewId: string,
): Promise<void> {
  if (before.size === 0) return;
  const after = await imageIds(ctx, host, base, cwd);
  const docker = ctx.docker ?? "docker";
  const empty = await mkdtemp(join(tmpdir(), "gangway-rmi-"));
  try {
    for (const img of before) {
      if (after.has(img)) continue;
      const res = await ctx.compose.capture(
        [docker, "image", "inspect", "--format", "{{len .RepoTags}} {{len .RepoDigests}}", img],
        host,
        { cwd: empty },
      );
      if (res.code !== 0 || res.stdout.trim() !== "0 0") continue;
      const removed = await ctx.compose.capture([docker, "image", "rm", img], host, { cwd: empty });
      if (removed.code === 0)
        ctx.logs.append(
          previewId,
          "system",
          `removed the replaced image ${img.replace(/^sha256:/, "").slice(0, 12)}`,
        );
    }
  } catch (e) {
    ctx.logger.warn("could not remove a replaced image", { previewId, err: e });
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
}
