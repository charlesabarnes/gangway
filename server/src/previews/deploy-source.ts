import { lstat, mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppPlan } from "@gangway/shared/app-plan";
import type { NetworkChoice, PreviewNetwork, PreviewSource } from "@gangway/shared/domain";
import type { RuntimeId } from "@gangway/shared/runtimes";
import { composeForImage } from "./compose-generate.ts";
import type { PreviewContext } from "./context.ts";
import type { DeploySource, RegistryLogin } from "./deploy-types.ts";
import { COMPOSE_FILE, ownStack } from "./own-stack.ts";
import { prepareUpload, type UploadContext } from "./prepare-upload.ts";
import { cloneRepo } from "./source/git.ts";
import { assertNoEscapingSymlinks } from "./source/guard.ts";
import { extractTarball } from "./source/tarball.ts";
import type { Workdir } from "./source/workdir.ts";

export type Materialized = {
  source: PreviewSource;
  composeFile: string;
  dotenv?: Record<string, string> | undefined;
  dockerConfig?: string;
  pristine?: string | null;
  runtime?: RuntimeId | null;
  plan?: AppPlan;
};

type Env = Record<string, string> | undefined;
/** Where a source is written: the preview it is for, its secrets and its working directory. */
export type SourceTarget = { id: string; env: Env; wd: Workdir };
type CloneContext = Pick<PreviewContext, "logs" | "logger" | "git">;
type SourceOf<K extends DeploySource["kind"]> = Extract<DeploySource, { kind: K }>;

async function writeDockerConfig(dir: string, login: RegistryLogin): Promise<string> {
  const cfg = join(dir, "docker-config");
  await mkdir(cfg, { recursive: true, mode: 0o700 });
  const auth = Buffer.from(`${login.username}:${login.password}`).toString("base64");
  await writeFile(
    join(cfg, "config.json"),
    JSON.stringify({ auths: { [login.server]: { auth } } }),
    { mode: 0o600 },
  );
  // Without the caller's cli-plugins linked in, a per-user compose plugin disappears for this command.
  const plugins = join(process.env["DOCKER_CONFIG"] ?? join(homedir(), ".docker"), "cli-plugins");
  if (await lstat(plugins).catch(() => null)) {
    await symlink(plugins, join(cfg, "cli-plugins")).catch(() => {});
  }
  return cfg;
}

export const networkField = (n: NetworkChoice | undefined): { network?: PreviewNetwork } =>
  n === "shared" || n === "isolated" ? { network: n } : {};

async function imageSource(source: SourceOf<"image">, wd: Workdir): Promise<Materialized> {
  await writeFile(join(wd.srcDir, COMPOSE_FILE), composeForImage(source), { mode: 0o600 });
  return {
    source: { kind: "image", image: source.image, ...networkField(source.network) },
    composeFile: COMPOSE_FILE,
  };
}

async function pushedSource(
  ctx: Pick<PreviewContext, "logs">,
  source: SourceOf<"pushed">,
  { id, env, wd }: SourceTarget,
): Promise<Materialized> {
  await writeFile(
    join(wd.srcDir, COMPOSE_FILE),
    composeForImage({ image: source.image, port: source.port, env }),
    { mode: 0o600 },
  );
  const dockerConfig = source.registry
    ? await writeDockerConfig(wd.dir, source.registry)
    : undefined;
  if (env && Object.keys(env).length > 0) {
    ctx.logs.append(id, "system", `passing ${Object.keys(env).length} secret(s) to the container`);
  }
  return {
    source: {
      kind: "pr",
      repo: source.pr.repo,
      number: source.pr.number,
      sha: source.pr.sha,
      image: source.image,
    },
    composeFile: COMPOSE_FILE,
    ...(dockerConfig ? { dockerConfig } : {}),
  };
}

async function cloneGit(
  ctx: CloneContext,
  id: string,
  source: SourceOf<"git">,
  wd: Workdir,
): Promise<PreviewSource> {
  const cloned = await cloneRepo({
    repo: source.repo,
    ref: source.ref,
    destDir: wd.srcDir,
    logger: ctx.logger,
    ...ctx.git,
  });
  ctx.logs.append(
    id,
    "system",
    `cloned ${source.repo} @ ${cloned.ref} (${cloned.sha.slice(0, 12)}) in ${cloned.durationMs}ms`,
  );
  return { kind: "git", repo: source.repo, ref: source.ref };
}

async function clonePr(
  ctx: CloneContext,
  id: string,
  source: SourceOf<"pr">,
  wd: Workdir,
): Promise<PreviewSource> {
  const cloned = await cloneRepo({
    repo: source.cloneUrl,
    ref: source.sha,
    destDir: wd.srcDir,
    token: source.credential,
    logger: ctx.logger,
    ...ctx.git,
  });
  ctx.logs.append(
    id,
    "system",
    `fetched ${source.repo}#${source.number} @ ${cloned.sha.slice(0, 12)} in ${cloned.durationMs}ms`,
  );
  return { kind: "pr", repo: source.repo, number: source.number, sha: source.sha };
}

async function clonedSource(
  ctx: CloneContext,
  source: SourceOf<"git" | "pr">,
  { id, env, wd }: SourceTarget,
): Promise<Materialized> {
  const recorded =
    source.kind === "git"
      ? await cloneGit(ctx, id, source, wd)
      : await clonePr(ctx, id, source, wd);
  await assertNoEscapingSymlinks(wd.srcDir);
  const stack = await ownStack(
    ctx,
    { logId: id, srcDir: wd.srcDir, stackDir: wd.dir, env, port: source.port },
    null,
  );
  return { source: recorded, ...stack };
}

async function tarballSource(
  ctx: UploadContext,
  source: SourceOf<"tarball">,
  { id, env, wd }: SourceTarget,
): Promise<Materialized> {
  const r = await extractTarball(source.archive, wd.srcDir);
  ctx.logs.append(id, "system", `unpacked ${r.files} files, ${r.totalBytes} bytes`);
  const up = await prepareUpload(
    ctx,
    { logId: id, wd, choice: source.runtime ?? "own", env, port: source.port },
    { addons: source.addons },
  );
  return {
    source: {
      kind: "tarball",
      uploadId: id,
      ...(source.pr ? { pr: source.pr } : {}),
      ...(up.runtime ? { runtime: up.runtime } : {}),
      ...(up.plan.addons.length ? { addons: up.plan.addons } : {}),
      ...networkField(source.network),
    },
    composeFile: up.composeFile,
    dotenv: up.dotenv,
    pristine: up.pristine,
    runtime: up.runtime,
    plan: up.plan,
  };
}

export async function writeSource(
  ctx: CloneContext & UploadContext,
  source: DeploySource,
  target: SourceTarget,
): Promise<Materialized> {
  switch (source.kind) {
    case "image":
      return imageSource(source, target.wd);
    case "pushed":
      return pushedSource(ctx, source, target);
    case "tarball":
      return tarballSource(ctx, source, target);
    case "git":
    case "pr":
      return clonedSource(ctx, source, target);
  }
}
