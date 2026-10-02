import type { Host } from "@gangway/shared/domain";
import type { PreviewContext } from "./context.ts";

export const PREVIOUS_TAG = "prev";

type ImagesContext = Pick<PreviewContext, "compose" | "docker" | "logger">;

export type ProjectScope = { host: Host; project: string; cwd: string };

const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*$/;

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

/** A serving preview whose images could not all be kept: a rebuild could not roll back. */
export class SnapshotFailed extends Error {}

/**
 * Tag what the project's containers run, stopped ones too, by image id (`:latest` may never have
 * served) as `:prev`. All or nothing: any failure drops what was tagged and throws SnapshotFailed.
 */
export async function keepPrevious(ctx: ImagesContext, s: ProjectScope): Promise<string[]> {
  const docker = ctx.docker ?? "docker";
  const run = (argv: string[]) => ctx.compose.capture(argv, s.host, { cwd: s.cwd });
  const kept: string[] = [];
  try {
    const ps = await run([
      docker,
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${s.project}`,
    ]);
    const containers = ps.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[0-9a-f]{12,64}$/.test(l));
    if (ps.code !== 0 || containers.length === 0) {
      throw new SnapshotFailed("found none of its containers");
    }
    const inspected = await run([
      docker,
      "container",
      "inspect",
      "--format",
      "{{.Config.Image}} {{.Image}}",
      ...containers,
    ]);
    const lines = inspected.stdout.split("\n").filter((l) => l.trim() !== "");
    if (inspected.code !== 0 || lines.length !== containers.length) {
      throw new SnapshotFailed("could not inspect its containers");
    }
    const images = new Map<string, string>();
    for (const line of lines) {
      const [ref = "", id = ""] = line.trim().split(" ");
      const name = ref.replace(/:latest$/, "");
      if (!name.startsWith(`${s.project}-`)) {
        continue;
      }
      if (!SAFE_NAME.test(name) || !IMAGE_ID.test(id) || (images.get(name) ?? id) !== id) {
        throw new SnapshotFailed(`could not tell which image ${name} runs`);
      }
      images.set(name, id);
    }
    for (const [name, id] of images) {
      const tagged = await run([docker, "image", "tag", id, `${name}:${PREVIOUS_TAG}`]);
      if (tagged.code !== 0) {
        throw new SnapshotFailed(`could not tag ${name}:${PREVIOUS_TAG}`);
      }
      kept.push(name);
    }
    return kept;
  } catch (e) {
    await dropPrevious(ctx, s, kept);
    throw e instanceof SnapshotFailed ? e : new SnapshotFailed(String(e));
  }
}

export async function dropPrevious(
  ctx: ImagesContext,
  s: ProjectScope,
  names: readonly string[],
): Promise<void> {
  const docker = ctx.docker ?? "docker";
  for (const name of names) {
    const res = await ctx.compose
      .capture([docker, "image", "rm", `${name}:${PREVIOUS_TAG}`], s.host, { cwd: s.cwd })
      .catch((e: unknown) => ({ code: 1, stderr: String(e) }));
    if (res.code !== 0) {
      ctx.logger.warn("could not drop a previous image's tag", {
        image: `${name}:${PREVIOUS_TAG}`,
        err: res.stderr.slice(-300),
      });
    }
  }
}

/** Move `:latest` back to `:prev`, all or nothing: on failure `:latest` is as it was, `:prev` kept. */
export async function restorePrevious(
  ctx: ImagesContext,
  s: ProjectScope,
  names: readonly string[],
): Promise<boolean> {
  const docker = ctx.docker ?? "docker";
  const run = (argv: string[]) => ctx.compose.capture(argv, s.host, { cwd: s.cwd });
  const moved: [string, string | null][] = [];
  for (const name of names) {
    const was = await run([docker, "image", "inspect", "--format", "{{.Id}}", `${name}:latest`]);
    const id = was.code === 0 && IMAGE_ID.test(was.stdout.trim()) ? was.stdout.trim() : null;
    const res = await run([docker, "image", "tag", `${name}:${PREVIOUS_TAG}`, `${name}:latest`]);
    if (res.code !== 0) {
      for (const [back, to] of moved) {
        await (to
          ? run([docker, "image", "tag", to, `${back}:latest`])
          : run([docker, "image", "rm", `${back}:latest`]));
      }
      ctx.logger.warn("could not move :latest back to the previous images; kept :prev", {
        image: name,
        err: res.stderr.slice(-300),
      });
      return false;
    }
    moved.push([name, id]);
  }
  await dropPrevious(ctx, s, names);
  return true;
}

/** Any `:prev` tag still carrying the project's label: a rebuild that never finished. */
export async function leftoverPrevious(ctx: ImagesContext, s: ProjectScope): Promise<string[]> {
  const docker = ctx.docker ?? "docker";
  const res = await ctx.compose
    .capture(
      [
        docker,
        "image",
        "ls",
        "--filter",
        `label=com.docker.compose.project=${s.project}`,
        "--filter",
        `reference=*:${PREVIOUS_TAG}`,
        "--format",
        "{{.Repository}}",
      ],
      s.host,
      { cwd: s.cwd },
    )
    .catch(() => ({ code: 1, stdout: "" }));
  return res.code === 0
    ? [
        ...new Set(
          res.stdout
            .split("\n")
            .map((l) => l.trim())
            .filter((n) => n.startsWith(`${s.project}-`) && SAFE_NAME.test(n)),
        ),
      ]
    : [];
}

/** Remove the project's untagged images: a build that never served, once `:latest` went back. */
export async function removeUntagged(ctx: ImagesContext, s: ProjectScope): Promise<void> {
  const docker = ctx.docker ?? "docker";
  const run = (argv: string[]) => ctx.compose.capture(argv, s.host, { cwd: s.cwd });
  try {
    const res = await run([
      docker,
      "image",
      "ls",
      "--quiet",
      "--filter",
      "dangling=true",
      "--filter",
      `label=com.docker.compose.project=${s.project}`,
    ]);
    const ids = [
      ...new Set(
        res.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => /^(sha256:)?[0-9a-f]{12,64}$/.test(l)),
      ),
    ];
    for (const id of res.code === 0 ? ids : []) {
      await run([docker, "image", "rm", id]);
    }
  } catch (e) {
    ctx.logger.warn("could not remove a failed build's images", { project: s.project, err: e });
  }
}
