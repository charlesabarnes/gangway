import { lstat, mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppPlan } from "@gangway/shared/app-plan";
import type {
  BrandChoice,
  NetworkChoice,
  PreviewNetwork,
  PreviewSource,
} from "@gangway/shared/domain";
import type { RuntimeId } from "@gangway/shared/runtimes";
import { composeForImage } from "./compose-generate.ts";
import type { PreviewContext } from "./context.ts";
import type { DeploySource, RegistryLogin } from "./deploy-types.ts";
import { COMPOSE_FILE, ownStack } from "./own-stack.ts";
import { prepareUpload } from "./prepare-upload.ts";
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
  if (await lstat(plugins).catch(() => null))
    await symlink(plugins, join(cfg, "cli-plugins")).catch(() => {});
  return cfg;
}

export const brandField = (b: BrandChoice | undefined): { brand?: "on" | "off" } =>
  b === "on" || b === "off" ? { brand: b } : {};

export const brandFor = (ctx: PreviewContext, b: BrandChoice | undefined): boolean =>
  b === "on" ? true : b === "off" ? false : (ctx.brandDefault?.() ?? true);

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
  ctx: PreviewContext,
  id: string,
  source: SourceOf<"pushed">,
  env: Env,
  wd: Workdir,
): Promise<Materialized> {
  await writeFile(
    join(wd.srcDir, COMPOSE_FILE),
    composeForImage({ image: source.image, port: source.port, env }),
    { mode: 0o600 },
  );
  const dockerConfig = source.registry
    ? await writeDockerConfig(wd.dir, source.registry)
    : undefined;
  if (env && Object.keys(env).length > 0)
    ctx.logs.append(id, "system", `passing ${Object.keys(env).length} secret(s) to the container`);
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
  ctx: PreviewContext,
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
  ctx: PreviewContext,
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
  ctx: PreviewContext,
  id: string,
  source: SourceOf<"git" | "pr">,
  env: Env,
  wd: Workdir,
): Promise<Materialized> {
  const recorded =
    source.kind === "git"
      ? await cloneGit(ctx, id, source, wd)
      : await clonePr(ctx, id, source, wd);
  await assertNoEscapingSymlinks(wd.srcDir);
  return { source: recorded, ...(await ownStack(ctx, id, wd.srcDir, env, source.port, null)) };
}

async function tarballSource(
  ctx: PreviewContext,
  id: string,
  source: SourceOf<"tarball">,
  env: Env,
  wd: Workdir,
): Promise<Materialized> {
  const r = await extractTarball(source.archive, wd.srcDir);
  ctx.logs.append(id, "system", `unpacked ${r.files} files, ${r.totalBytes} bytes`);
  const up = await prepareUpload(ctx, id, wd, source.runtime ?? "own", env, source.port, {
    addons: source.addons,
    brand: brandFor(ctx, source.brand),
  });
  return {
    source: {
      kind: "tarball",
      uploadId: id,
      ...(up.runtime ? { runtime: up.runtime } : {}),
      ...(up.plan.addons.length ? { addons: up.plan.addons } : {}),
      ...networkField(source.network),
      ...brandField(source.brand),
    },
    composeFile: up.composeFile,
    dotenv: up.dotenv,
    pristine: up.pristine,
    runtime: up.runtime,
    plan: up.plan,
  };
}

export async function writeSource(
  ctx: PreviewContext,
  id: string,
  source: DeploySource,
  env: Env,
  wd: Workdir,
): Promise<Materialized> {
  switch (source.kind) {
    case "image":
      return imageSource(source, wd);
    case "pushed":
      return pushedSource(ctx, id, source, env, wd);
    case "tarball":
      return tarballSource(ctx, id, source, env, wd);
    case "git":
    case "pr":
      return clonedSource(ctx, id, source, env, wd);
  }
}
