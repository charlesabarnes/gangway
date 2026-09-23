/**
 * The deploy pipeline. This is the one code path that can create a preview, and there is
 * not an HTTP type in it.
 *
 * Two halves, split where the answer to "what is my URL?" becomes known:
 *
 *   plan   (awaited by the caller)  source -> `compose config` -> policy -> hostnames
 *                                   and ports -> preview row + route rows
 *   run    (background)             stack file -> build -> up -> healthy -> answering
 *
 * A failure while planning leaves nothing behind -- no row, no route, no container --
 * and surfaces as a 4xx to the caller. A failure while running leaves a `failed` preview
 * whose URL serves the log tail, because by then someone may be watching it.
 *
 * The route rows are written before containers start, never after: at the end of `plan`,
 * while `compose up` is in `run`. That ordering is structural.
 */
import { randomBytes } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import {
  projectNameFor,
  type Clearance,
  type Host,
  type Preview,
  type PreviewSource,
  type Route,
  type Visibility,
  type PasswordLogin,
} from "@gangway/shared/domain";
import { slugify } from "@gangway/shared/hostname";
import { publicOriginFor } from "@gangway/shared/url";
import { actorId, principalOf, type Actor } from "../auth/actor.ts";
import {
  buildArgv,
  composeArgv,
  downArgv,
  parseComposePs,
  psArgv,
  runArgv,
  upArgv,
} from "../docker/compose.ts";
import { AppError, conflict, errorMessage, unprocessable } from "../errors.ts";
import { redactString } from "../logger.ts";
import { allocatePorts } from "../routing/ports.ts";
import { place } from "../scheduler/placement.ts";
import { sleep } from "../util/async.ts";
import { idleMs, parseDuration } from "../util/duration.ts";
import { ulid } from "../util/ulid.ts";
import { parse as parseYaml } from "yaml";
import {
  buildStack,
  composeForDockerfile,
  composeForImage,
  parseComposeModel,
  planRoutes,
  selectExposed,
  type ComposeModel,
  type PlannedRoute,
} from "./compose-model.ts";
import type { PreviewContext } from "./context.ts";
import { rmiFor } from "./destroy.ts";
import { cloneRepo } from "./source/git.ts";
import { dotenvLine } from "../secrets/secrets.ts";
import { assertNoEscapingSymlinks, COMPOSE_FILENAMES, inspectComposeFile } from "./source/guard.ts";
import { extractTarball, type TarballSource } from "./source/tarball.ts";
import type { Workdir } from "./source/workdir.ts";
import { GENERATED_DIR } from "./source/store.ts";
import {
  assertRunnable,
  planFromDisk,
  stackX,
  writeRuntime,
  type RuntimeChoice,
} from "./runtimes.ts";
import type { AddonRequest, AppPlan } from "@gangway/shared/app-plan";
import type { AddonChoice } from "@gangway/shared/addons";
import { renderAddons, type RenderedAddons } from "./addons.ts";
import { DIR_MODE, FILE_MODE } from "./source/types.ts";
import type { RuntimeId } from "@gangway/shared/runtimes";
import type { PasswordChoice } from "@gangway/shared/api";
import { entryPassword, logGenerated, resolvePassword } from "./password.ts";

export type DeploySource =
  | { kind: "image"; image: string; port: number; env?: Record<string, string> | undefined }
  /**
   * Cloned by the server itself. `port` is only for a repo with a Dockerfile and no compose
   * file.
   */
  | { kind: "git"; repo: string; ref: string; port?: number | undefined }
  /**
   * A pull request's head. `credential` is presented to git and forgotten: it is
   * not on the recorded source, not in a label, not in the log.
   */
  | {
      kind: "pr";
      repo: string;
      number: number;
      sha: string;
      cloneUrl: string;
      credential: string | undefined;
      port?: number | undefined;
    }
  /**
   * A tar or tar.gz of the project. `runtime` builds it with a runtime, `auto`
   * detects one; absent or `own`, the upload brings its compose file (or Dockerfile).
   */
  | {
      kind: "tarball";
      archive: TarballSource;
      port?: number | undefined;
      digest?: string | undefined;
      runtime?: RuntimeChoice | undefined;
      addons?: readonly AddonRequest[] | undefined;
    }
  /**
   * An image a workflow built and pushed for one commit of a pull request.
   * `registry` logs in for this pull only: written to a DOCKER_CONFIG in the work
   * directory for `up`, deleted after it, never recorded, never logged.
   */
  | {
      kind: "pushed";
      image: string;
      port: number;
      pr: { repo: string; number: number; sha: string };
      registry?: RegistryLogin | undefined;
    };

export type RegistryLogin = { server: string; username: string; password: string };

export type DeployInput = {
  actor: Actor;
  source: DeploySource;
  /**
   * Written to `<checkout>/.env` before compose reads anything. Given -- even
   * empty -- it is final; absent, the context may supply a repository's secrets by source.
   */
  env?: Record<string, string> | undefined;
  /**
   * The clearance to deploy with. Recorded on the row; the context's lookup filters by it.
   */
  secretLevel?: Clearance | undefined;
  /** The hostname stem. Defaults to something derived from the source. */
  name?: string | undefined;
  visibility?: Visibility | undefined;
  /** A duration (`12h`, `7d`), or null for no expiry. */
  ttl?: string | null | undefined;
  hostId?: string | undefined;
  /** A template by id. Omitted: the project's, else the trigger's default. */
  template?: string | undefined;
  /** The project it belongs to. Omitted: found from the source's repository, if any. */
  projectId?: string | undefined;
  /** The preview password. Omitted: inherit the server-wide default. */
  password?: PasswordChoice | undefined;
  /** Whether a gangway login gets past the password. Omitted: inherit. */
  passwordLogin?: PasswordLogin | undefined;
};

export type PreviewUrl = { service: string; url: string; primary: boolean };

export type DeployResult = {
  preview: Preview;
  urls: PreviewUrl[];
  /** Settles when the pipeline does. Resolves with the final preview -- awake or failed. */
  done: Promise<Preview>;
  /**
   * An upload's plan: what was found and what runs, for an agent to read back. Absent
   * otherwise.
   */
  plan?: AppPlan | undefined;
};

/** A placeholder `-p` for the config passes, which run before the real name is known. */
export const PLAN_PROJECT = "gw-plan";
const COMPOSE_FILE = "compose.yaml";
/** What we actually `up`: compose's canonical output with our changes applied. */
export const STACK_FILE = "gangway.stack.yaml";

/** An unguessable hostname suffix: 50 bits, lowercase base32 without lookalikes. */
function unguessable(): string {
  const alphabet = "abcdefghjkmnpqrstvwxyz0123456789";
  return Array.from(randomBytes(10), (b) => alphabet[b % 32]).join("");
}

function defaultName(source: DeploySource, runtime: RuntimeId | null): string {
  // A runtime preview is made on a whim, several at a time: its default must not collide.
  if (source.kind === "tarball")
    return runtime ? `${runtime}-${unguessable().slice(0, 4)}` : "preview";
  if (source.kind === "pr") return `${source.repo.split("/").pop() ?? "repo"}-pr-${source.number}`;
  if (source.kind === "pushed")
    return `${source.pr.repo.split("/").pop() ?? "repo"}-pr-${source.pr.number}`;
  // "ghcr.io/acme/web-app:1.2" -> "web-app";  "https://github.com/acme/web-app.git" -> "web-app"
  const from =
    source.kind === "git" ? source.repo.replace(/\/+$/, "").replace(/\.git$/, "") : source.image;
  const last = from.split("/").pop() ?? from;
  return slugify(last.split(/[:@]/)[0] ?? last) || "preview";
}

export function urlsFor(
  ctx: Pick<PreviewContext, "table" | "origin">,
  previewId: string,
): PreviewUrl[] {
  return ctx.table
    .forPreview(previewId)
    .map((e) => ({
      service: e.service,
      url: `${publicOriginFor(e.hostname, ctx.origin)}/`,
      primary: e.primary,
    }))
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.service.localeCompare(b.service));
}

/* ------------------------------------------------------------------ plan */

type Materialized = {
  source: PreviewSource;
  composeFile: string;
  dockerConfig?: string;
  /** An upload as it arrived, to keep once the preview exists. */
  pristine?: string | null;
  runtime?: RuntimeId | null;
  plan?: AppPlan;
};

/**
 * A DOCKER_CONFIG holding one registry login, for one `up`. The CLI looks for plugins
 * under DOCKER_CONFIG too, so the caller's `cli-plugins` is linked in: without it a
 * compose plugin installed per-user vanishes for exactly this command.
 */
async function writeDockerConfig(dir: string, login: RegistryLogin): Promise<string> {
  const cfg = join(dir, "docker-config");
  await mkdir(cfg, { recursive: true, mode: 0o700 });
  const auth = Buffer.from(`${login.username}:${login.password}`).toString("base64");
  await writeFile(
    join(cfg, "config.json"),
    JSON.stringify({ auths: { [login.server]: { auth } } }),
    { mode: 0o600 },
  );
  const plugins = join(process.env["DOCKER_CONFIG"] ?? join(homedir(), ".docker"), "cli-plugins");
  if (await lstat(plugins).catch(() => null))
    await symlink(plugins, join(cfg, "cli-plugins")).catch(() => {});
  return cfg;
}

/**
 * The repository's secrets, as the `.env` compose reads for `${VAR}` and for
 * `env_file: .env`. A committed `.env` is kept and the secrets appended, so a secret
 * wins over a committed placeholder.
 */
async function writeDotenv(srcDir: string, env: Record<string, string>): Promise<number> {
  const names = Object.keys(env);
  if (names.length === 0) return 0;
  const file = join(srcDir, ".env");
  const st = await lstat(file).catch(() => null);
  if (st && !st.isFile()) throw unprocessable(".env in the source is not a regular file");
  const committed = st ? await Bun.file(file).text() : "";
  const lines = names.map((k) => dotenvLine(k, env[k]!));
  const body = `${committed.replace(/\s*$/, "")}${committed.trim() === "" ? "" : "\n"}# --- gangway: repository secrets ---\n${lines.join("\n")}\n`;
  await writeFile(file, body, { mode: 0o600 });
  return names.length;
}

/** Put the source on disk and find its compose file -- trusting neither. */
async function writeSource(
  ctx: PreviewContext,
  id: string,
  source: DeploySource,
  env: Record<string, string> | undefined,
  wd: Workdir,
): Promise<Materialized> {
  if (source.kind === "image") {
    await writeFile(join(wd.srcDir, COMPOSE_FILE), composeForImage(source), { mode: 0o600 });
    return { source: { kind: "image", image: source.image }, composeFile: COMPOSE_FILE };
  }
  if (source.kind === "pushed") {
    // No checkout, so no .env file: the project's secrets reach the one service as its
    // environment.
    await writeFile(
      join(wd.srcDir, COMPOSE_FILE),
      composeForImage({ image: source.image, port: source.port, env }),
      { mode: 0o600 },
    );
    const dockerConfig = source.registry
      ? await writeDockerConfig(wd.dir, source.registry)
      : undefined;
    if (env && Object.keys(env).length > 0)
      ctx.logs.append(
        id,
        "system",
        `passing ${Object.keys(env).length} secret(s) to the container`,
      );
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

  let recorded: PreviewSource;
  if (source.kind === "git") {
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
    recorded = { kind: "git", repo: source.repo, ref: source.ref };
  } else if (source.kind === "pr") {
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
    recorded = { kind: "pr", repo: source.repo, number: source.number, sha: source.sha };
  } else {
    const r = await extractTarball(source.archive, wd.srcDir);
    ctx.logs.append(id, "system", `unpacked ${r.files} files, ${r.totalBytes} bytes`);
    const up = await prepareUpload(ctx, id, wd, source.runtime ?? "own", env, source.port, {
      addons: source.addons,
    });
    return {
      source: {
        kind: "tarball",
        uploadId: id,
        ...(up.runtime ? { runtime: up.runtime } : {}),
        ...(up.plan.addons.length ? { addons: up.plan.addons } : {}),
      },
      composeFile: up.composeFile,
      pristine: up.pristine,
      runtime: up.runtime,
      plan: up.plan,
    };
  }

  // Both checks come before `compose config`, which opens whatever the file points it at.
  await assertNoEscapingSymlinks(wd.srcDir);
  return {
    source: recorded,
    composeFile: await ownStack(ctx, id, wd.srcDir, env, source.port, null),
  };
}

/**
 * A checkout or upload that brings its own compose file, or a Dockerfile and a port. An
 * upload's `gangway.yml` may name the port, env and policy for a lone Dockerfile.
 */
async function ownStack(
  ctx: PreviewContext,
  id: string,
  srcDir: string,
  env: Record<string, string> | undefined,
  askedPort: number | undefined,
  plan: AppPlan | null,
  sidecars?: RenderedAddons,
): Promise<string> {
  if (env) {
    const n = await writeDotenv(srcDir, env);
    if (n > 0)
      ctx.logs.append(id, "system", `wrote .env with ${n} repository secret${n === 1 ? "" : "s"}`);
  }
  const found = await inspectComposeFile(srcDir);
  if (found) return found;

  const dockerfile = await lstat(join(srcDir, "Dockerfile")).catch(() => null);
  if (!dockerfile?.isFile()) {
    throw unprocessable(
      `the source has no compose file (${COMPOSE_FILENAMES.join(", ")}) and no Dockerfile at its root -- or choose a runtime to build it with`,
    );
  }
  const port = askedPort ?? plan?.port ?? undefined;
  if (port === undefined) {
    throw unprocessable(
      "the source has a Dockerfile but no compose file, so `port` is required: the port the app listens on inside the container (`port:` in gangway.yml, or ?port=)",
    );
  }
  if (sidecars) {
    await mkdir(join(srcDir, GENERATED_DIR), { recursive: true, mode: DIR_MODE });
    for (const [name, body] of Object.entries(sidecars.files))
      await writeFile(join(srcDir, GENERATED_DIR, name), body, { mode: FILE_MODE });
  }
  // A lone Dockerfile's env: gangway.yml's, then the add-ons'. Secrets reach it as the .env
  // above.
  const appEnv = { ...(plan?.env ?? {}), ...(sidecars?.appEnv ?? {}) };
  await writeFile(
    join(srcDir, COMPOSE_FILE),
    composeForDockerfile({
      port,
      env: appEnv,
      health: plan?.health,
      sidecars,
      ...(plan ? { stack: stackX(plan) } : {}),
    }),
    { mode: 0o600 },
  );
  return COMPOSE_FILE;
}

export type PreparedUpload = {
  composeFile: string;
  runtime: RuntimeId | null;
  pristine: string | null;
  plan: AppPlan;
};

/** The options a plan takes beyond the files: what was asked for, and what a rebuild had. */
export type PlanOptions = {
  previous?: RuntimeId | "own" | undefined;
  addons?: readonly AddonRequest[] | undefined;
  previousAddons?: readonly AddonChoice[] | undefined;
};

/**
 * An upload on disk -> the compose file to read. Deploy and redeploy both come
 * through here. The pristine copy -- what is kept -- is taken after the symlink guard and
 * before gangway writes `.env` or `.gangway/` into the tree.
 */
export async function prepareUpload(
  ctx: PreviewContext,
  logId: string,
  wd: Workdir,
  choice: RuntimeChoice,
  env: Record<string, string> | undefined,
  port: number | undefined,
  opts: PlanOptions = {},
): Promise<PreparedUpload> {
  await assertNoEscapingSymlinks(wd.srcDir);
  let pristine: string | null = null;
  if (ctx.sources) {
    pristine = join(wd.dir, "pristine");
    await rm(pristine, { recursive: true, force: true });
    await cp(wd.srcDir, pristine, {
      recursive: true,
      verbatimSymlinks: true,
      // Generated files live in `<root>/.gangway/`; none of them, at any depth, is the user's.
      filter: (src) =>
        src === wd.srcDir || !relative(wd.srcDir, src).split(sep).includes(GENERATED_DIR),
    });
  }
  const plan = await planFromDisk(wd.srcDir, choice, opts);
  assertRunnable(plan);
  for (const r of plan.reasons)
    ctx.logs.append(
      logId,
      "system",
      `plan: ${r.level === "info" ? "" : `${r.level}: `}${r.found} -> ${r.then}`,
    );
  let sidecars: RenderedAddons | undefined;
  if (plan.addons.length > 0) {
    const secret = ctx.addonSecret;
    if (!secret)
      throw new AppError(
        "internal",
        "add-ons are not available: no key to derive their passwords from",
      );
    sidecars = renderAddons(plan.addons, (a) => secret(logId, a), plan.sqlSeed, plan.root || ".");
    // Before anything that could print them: compose's own output, a seed, a release.
    ctx.logs.mask(logId, sidecars.secrets);
    const shadowed = Object.keys(sidecars.appEnv).filter(
      (k) => env?.[k] !== undefined || plan.env[k] !== undefined,
    );
    if (shadowed.length > 0)
      ctx.logs.append(
        logId,
        "system",
        `add-ons set ${shadowed.join(", ")}, replacing the value${shadowed.length === 1 ? "" : "s"} from secrets or gangway.yml`,
      );
  }
  if (plan.kind === "own") {
    if (choice === "auto")
      ctx.logs.append(logId, "system", "detected the upload's own compose file / Dockerfile");
    return {
      composeFile: await ownStack(ctx, logId, wd.srcDir, env, port, plan, sidecars),
      runtime: null,
      pristine,
      plan,
    };
  }
  const runtime = plan.runtime!;
  // `port`, if given, overrides the runtime's own: a rebuild keeps the preview's.
  const { composeFile, note } = await writeRuntime(
    wd.srcDir,
    plan,
    env,
    join(wd.dir, "runtime.compose.yaml"),
    port,
    sidecars,
  );
  ctx.logs.append(
    logId,
    "system",
    `${choice === "auto" ? "detected " : ""}runtime ${runtime}: ${note}`,
  );
  const secrets = Object.keys(env ?? {}).length;
  if (secrets > 0)
    ctx.logs.append(
      logId,
      "system",
      `passing ${secrets} secret(s) to the container as environment`,
    );
  return { composeFile, runtime, pristine, plan };
}

type Planned = { model: ComposeModel; resolved: unknown };

export async function readModel(
  ctx: PreviewContext,
  host: Host,
  wd: Workdir,
  composeFile: string,
): Promise<Planned> {
  const argv = composeArgv({
    project: PLAN_PROJECT,
    files: [join(wd.srcDir, composeFile)],
    projectDirectory: wd.srcDir,
    docker: ctx.docker,
    // YAML, not `--format json`: JSON output drops service-level x-gangway. See
    // compose-model.ts.
    command: "config",
  });
  const r = await ctx.compose.capture(argv, host, { cwd: wd.srcDir });
  if (r.code !== 0)
    throw unprocessable("the compose file is not valid", {
      compose: redactString(r.stderr).slice(-2_000),
    });
  let resolved: unknown;
  try {
    resolved = parseYaml(r.stdout);
  } catch {
    throw new AppError("internal", "could not read `compose config` output");
  }

  // Both spellings: compose may hand back the path as given or with symlinks resolved
  // (on macOS every temp dir is one).
  const model = parseComposeModel(PLAN_PROJECT, resolved, [wd.srcDir, await realpath(wd.srcDir)]);
  if (model.violations.length > 0) {
    throw unprocessable("the compose file asks for things a preview may not have", {
      violations: model.violations,
    });
  }
  return { model, resolved };
}

export async function deploy(ctx: PreviewContext, input: DeployInput): Promise<DeployResult> {
  const id = ulid(ctx.now());
  // The template first -- it may place the preview, and it fills every gap below.
  const { template, project: owner } = ctx.policy.resolve({
    source: input.source,
    actor: input.actor,
    template: input.template,
    projectId: input.projectId,
  });
  const allHosts = ctx.hosts.list();
  let wantedHost = input.hostId ?? template.hostId ?? undefined;
  if (
    input.hostId === undefined &&
    template.hostId !== null &&
    !allHosts.some((h) => h.id === template.hostId)
  ) {
    // The template names a host that left the config. Placing it anyway beats failing
    // every preview on that template for a stale row.
    ctx.logger.warn(
      "template names a host that does not exist; letting the scheduler place the preview",
      { template: template.id, hostId: template.hostId },
    );
    wantedHost = undefined;
  }
  // Placement is decided here and nowhere else, even while there is one host.
  const host = place({ capability: "preview", hostId: wantedHost }, allHosts);
  const wd = await ctx.workdirs.create(id);

  let preview: Preview;
  let planned: Planned;
  let routes: PlannedRoute[];
  let visibility: Visibility;
  let dockerConfig: string | undefined;
  let pristine: string | null;
  let runtimeUsed: RuntimeId | null;
  let appPlan: AppPlan | undefined;
  let generatedPassword: string | undefined;
  try {
    // The clearance: asked for, else the project's override, else the template's.
    const secretLevel: Clearance = input.secretLevel ?? owner?.prClearance ?? template.clearance;
    const env =
      input.env !== undefined
        ? input.env
        : secretLevel === "none"
          ? {}
          : ctx.secretsFor?.(owner?.id ?? null, secretLevel);
    const {
      source,
      composeFile,
      dockerConfig: login,
      pristine: kept,
      runtime,
      plan,
    } = await writeSource(ctx, id, input.source, env, wd);
    appPlan = plan;
    dockerConfig = login;
    pristine = kept ?? null;
    runtimeUsed = runtime ?? null;
    planned = await readModel(ctx, host, wd, composeFile);
    const { model } = planned;
    const exposed = selectExposed(model);

    // Per field: the request, the project's override, the stack's own word, the template.
    visibility = input.visibility ?? owner?.visibility ?? model.x.visibility ?? template.visibility;
    // A private preview is opened by logging in to the UI (net/gate.ts). With the UI switched
    // off there is no login page to send anyone to: say so now, not with a dead link later.
    if (
      (visibility === "private" || input.passwordLogin === "only") &&
      ctx.privateAvailable?.() === false
    ) {
      throw unprocessable(
        "private previews need the web UI, which is switched off (surfaces.ui); use unlisted instead",
      );
    }

    const ttlText =
      input.ttl !== undefined ? input.ttl : (owner?.ttl ?? model.x.ttl ?? template.ttl);
    const ttlMs = ttlText === null ? null : parseDuration(ttlText);
    if (ttlText !== null && ttlMs === null)
      throw unprocessable(`ttl ${JSON.stringify(ttlText)} is not a duration like 12h or 7d`);

    // Hashed before the synchronous block below (scrypt is async).
    const password = await resolvePassword(ctx.passwords, input.password);

    const stem = slugify(input.name ?? defaultName(input.source, runtimeUsed));
    if (stem === "") throw unprocessable("name has no usable characters");
    const slug = visibility === "unlisted" ? `${stem}-${unguessable()}` : stem;
    const project = projectNameFor(ctx.instance, slug);

    const existing = ctx.previews.getByProject(project);
    if (existing && existing.state !== "destroyed") {
      throw conflict(`a preview named "${slug}" already exists`, {
        previewId: existing.id,
        state: existing.state,
      });
    }

    // ---- from here to the end of the block is synchronous. Ports are allocated from
    // the route table and claimed in the route table with no await in between, so two
    // concurrent deploys cannot be handed the same port.
    routes = planRoutes({
      previewId: id,
      slug,
      baseDomain: ctx.baseDomain(),
      host,
      exposed,
      allocate: (n) =>
        allocatePorts(host.ports, ctx.table.usedPorts(host.upstream.address), n, host.id),
    });
    if (existing) {
      ctx.previews.delete(existing.id);
      ctx.logs.remove(existing.id);
    }
    // The idle window is pinned on the row: the stack's own word, else the template's, so a
    // later template edit changes new previews and not running ones.
    const idleAfterMs = idleMs(model.x.idle ?? template.idleAfter);
    preview = ctx.previews.create({
      id,
      project,
      hostId: host.id,
      state: "building",
      source,
      visibility,
      ttlExpiresAt: ttlMs === null ? null : new Date(ctx.now() + ttlMs),
      idleAfterMs,
      secretLevel,
      templateId: template.id,
      projectId: owner?.id ?? null,
      owner: principalOf(input.actor),
      password: password.stored,
      passwordLogin: input.passwordLogin ?? "inherit",
    });
    generatedPassword = password.generated;
    try {
      for (const route of routes) {
        ctx.table.apply({
          route: { ...route, createdAt: preview.createdAt },
          hostId: host.id,
          project,
          visibility,
          password: entryPassword(password.stored),
          passwordLogin: input.passwordLogin ?? "inherit",
          state: "building",
        });
      }
    } catch (e) {
      ctx.table.removePreview(id);
      ctx.previews.delete(id);
      throw /UNIQUE|PRIMARY/i.test(String(e))
        ? conflict("that hostname is already taken by another preview")
        : e;
    }
    // ---- end synchronous block
  } catch (e) {
    await wd.cleanup();
    ctx.logs.remove(id);
    throw e;
  }

  // The upload is kept once there is a preview to keep it for. Losing it costs the
  // editor, not the deploy.
  if (pristine && ctx.sources) {
    await ctx.sources
      .adopt(id, pristine)
      .catch((e) =>
        ctx.logger.warn("could not keep the uploaded source", { previewId: id, err: e }),
      );
  }

  const urls = urlsFor(ctx, id);
  ctx.bus.publish(
    "preview.created",
    { project: preview.project, by: actorId(input.actor), urls: urls.map((u) => u.url) },
    id,
  );
  ctx.logs.append(id, "system", `deploying ${preview.project} to host ${host.id}`);
  if (generatedPassword) logGenerated(ctx, id, generatedPassword);
  // After the rows exist: a rejected deploy made nothing, so there is nothing to have done.
  ctx.audit.record(input.actor, "preview.deploy", id, {
    new: {
      project: preview.project,
      visibility,
      passwordMode: preview.password,
      source: input.source.kind,
      hostId: host.id,
      urls: urls.map((u) => u.url),
    },
  });

  const abort = new AbortController();
  const done = run(ctx, {
    preview,
    host,
    wd,
    ...planned,
    routes,
    visibility,
    dockerConfig,
    signal: abort.signal,
  }).finally(() => {
    ctx.inflight.delete(id);
  });
  ctx.inflight.set(id, { abort, done });

  return { preview, urls, done, plan: appPlan };
}

/* ------------------------------------------------------------------ run */

type RunInput = {
  preview: Preview;
  host: Host;
  wd: Workdir;
  model: ComposeModel;
  resolved: unknown;
  routes: PlannedRoute[];
  visibility: Visibility;
  signal: AbortSignal;
  /** A one-deploy registry login, for `up`'s pull. Deleted once `up` returns. */
  dockerConfig?: string | undefined;
};

export class StepFailed extends Error {
  readonly exitCode: number | null;
  constructor(message: string, exitCode: number | null = null) {
    super(message);
    this.exitCode = exitCode;
  }
}

async function run(ctx: PreviewContext, r: RunInput): Promise<Preview> {
  const { preview, host, wd } = r;
  const id = preview.id;
  const log = (line: string) => ctx.logs.append(id, "system", line);
  const stackPath = join(wd.dir, STACK_FILE);
  // One file. The user's compose.yaml is not on this command line: it has already been
  // read, by compose itself, into the document the stack file was built from.
  const base = {
    project: preview.project,
    files: [stackPath],
    projectDirectory: wd.srcDir,
    docker: ctx.docker,
  };

  const step = stepper(ctx, { previewId: id, host, cwd: wd.srcDir, signal: r.signal });

  let upAttempted = false;
  try {
    await writeFile(
      stackPath,
      buildStack({
        resolved: r.resolved,
        planProject: PLAN_PROJECT,
        model: r.model,
        routes: r.routes,
        createdAt: preview.createdAt,
        ctx: {
          instance: ctx.instance,
          env: ctx.env,
          project: preview.project,
          hostId: host.id,
          visibility: r.visibility,
        },
        publishBind: host.publishBind,
        origin: ctx.origin,
      }),
      { mode: 0o600 },
    );

    const toBuild = r.model.services.filter((s) => s.hasBuild).map((s) => s.name);
    if (toBuild.length > 0) {
      const buildId = ulid(ctx.now());
      ctx.builds.start({ id: buildId, previewId: id, services: toBuild });
      try {
        await step("build", buildArgv(base, toBuild), "build");
        ctx.builds.finish(buildId, "succeeded", 0);
      } catch (e) {
        ctx.builds.finish(
          buildId,
          r.signal.aborted ? "cancelled" : "failed",
          e instanceof StepFailed ? e.exitCode : null,
        );
        throw e;
      }
    }

    ctx.states.transition(id, "starting");
    upAttempted = true;
    try {
      await step(
        "up",
        upArgv(base, ["--no-build", "--remove-orphans"]),
        "stdout",
        r.dockerConfig ? { DOCKER_CONFIG: r.dockerConfig } : undefined,
      );
    } finally {
      // The login was for this pull. Gone before anything else runs, success or not.
      if (r.dockerConfig) await rm(r.dockerConfig, { recursive: true, force: true });
    }

    const target: WaitTarget = {
      previewId: id,
      host,
      routes: r.routes,
      signal: r.signal,
      ps: psArgv(base, ["--all"]),
      cwd: wd.srcDir,
      health: healthOf(r.model),
    };
    await waitHealthy(ctx, target);

    // The release command runs before every version goes live; here, before the seed.
    const release = releaseFor(r.model, r.routes);
    if (release) {
      log(`release: ${release.command} (in ${release.service})`);
      await step(
        "run (release)",
        runArgv(base, release.service, ["sh", "-c", release.command], ["--no-deps", "-T"]),
        "seed",
      );
    }

    // The seed runs once, healthy but not yet routed. Failing it fails the preview.
    const seed = seedFor(r.model, r.routes);
    if (seed) {
      log(`seeding: ${seed.command} (in ${seed.service})`);
      await step(
        "run (seed)",
        runArgv(base, seed.service, ["sh", "-c", seed.command], ["--no-deps", "-T"]),
        "seed",
      );
    }

    await waitAnswering(ctx, target);

    log("awake");
    return ctx.states.transition(id, "awake");
  } catch (e) {
    // destroy() aborted us and owns the preview from here; do not fight it for the state.
    if (r.signal.aborted) return ctx.previews.get(id) ?? preview;

    const message = redactString(errorMessage(e));
    if (!(e instanceof StepFailed))
      ctx.logger.error("deploy pipeline error", { previewId: id, err: e });
    log(`FAILED: ${message}`);
    if (upAttempted) await salvage(ctx, r);
    return ctx.states.transition(id, "failed", message);
  } finally {
    await wd.cleanup();
  }
}

export type Step = (
  what: string,
  argv: string[],
  stream: "build" | "seed" | "stdout",
  env?: Record<string, string>,
) => Promise<void>;

/** Streams a compose command into the preview log; throws unless it exits 0. */
export function stepper(
  ctx: PreviewContext,
  o: { previewId: string; host: Host; cwd: string; signal: AbortSignal },
): Step {
  return async (what, argv, stream, env) => {
    ctx.logs.append(o.previewId, "system", `$ compose ${what}`);
    for await (const ev of ctx.compose.stream(argv, o.host, {
      cwd: o.cwd,
      signal: o.signal,
      ...(env ? { env } : {}),
    })) {
      if (ev.type === "line")
        ctx.logs.append(
          o.previewId,
          ev.stream === "stderr" && stream === "stdout" ? "stderr" : stream,
          ev.line,
        );
      else if (ev.code !== 0)
        throw new StepFailed(
          `compose ${what} exited ${ev.code}${ev.signal ? ` (${ev.signal})` : ""}`,
          ev.code,
        );
    }
    o.signal.throwIfAborted();
  };
}

/** The seed hook as `{ service, command }`, the primary route's service filling in. */
function seedFor(
  model: ComposeModel,
  routes: PlannedRoute[],
): { service: string; command: string } | null {
  const seed = model.x.seed;
  if (seed === undefined) return null;
  if (typeof seed !== "string") return seed;
  const primary = routes.find((r) => r.primary) ?? routes[0];
  if (!primary)
    throw unprocessable("x-gangway.seed names no service and nothing is exposed to run it in");
  return { service: primary.service, command: seed };
}

/** The release command, in the primary route's service. */
export function releaseFor(
  model: ComposeModel,
  routes: PlannedRoute[],
): { service: string; command: string } | null {
  const command = model.x.release;
  if (command === undefined) return null;
  const primary = routes.find((r) => r.primary) ?? routes[0];
  if (!primary) throw unprocessable("x-gangway.release needs an exposed service to run in");
  return { service: primary.service, command };
}

/** Each service's `x-gangway.health` path, for the answering probe. */
export const healthOf = (model: ComposeModel): Record<string, string> =>
  Object.fromEntries(model.services.flatMap((s) => (s.x.health ? [[s.name, s.x.health]] : [])));

/** What the two waits need: a deploy has it from its plan, a wake from the route table. */
export type WaitTarget = {
  previewId: string;
  host: Host;
  routes: Pick<Route, "service" | "hostname" | "upstream" | "containerPort">[];
  signal: AbortSignal;
  /** The `ps` argv -- with the stack file for a deploy, file-less for a wake. */
  ps: string[];
  cwd: string;
  /** Per service, a path that must answer 2xx/3xx. A wake has none: any answer will do. */
  health?: Record<string, string> | undefined;
};

/** Gate on healthchecks, not on container start. */
export async function waitHealthy(ctx: PreviewContext, r: WaitTarget): Promise<void> {
  const deadline = Date.now() + ctx.timings.startTimeoutMs;
  const argv = r.ps;
  let last = "";
  for (;;) {
    r.signal.throwIfAborted();
    const res = await ctx.compose.capture(argv, r.host, { cwd: r.cwd, signal: r.signal });
    const rows = res.code === 0 ? parseComposePs(res.stdout) : [];
    const routed = new Set(r.routes.map((x) => x.service));

    for (const c of rows) {
      const died =
        c.state === "dead" || (c.state === "exited" && (c.exitCode !== 0 || routed.has(c.service)));
      if (died)
        throw new StepFailed(
          `service "${c.service}" exited${c.exitCode === null ? "" : ` with code ${c.exitCode}`}`,
        );
      if (c.health === "unhealthy") throw new StepFailed(`service "${c.service}" is unhealthy`);
    }
    // A one-shot service (a migration) that exited 0 is done, not broken.
    const waiting = rows
      .filter((c) => !(c.state === "exited" && c.exitCode === 0))
      .filter((c) => c.state !== "running" || (c.health !== null && c.health !== "healthy"));
    const seen = new Set(rows.map((c) => c.service));
    const missing = [...routed].filter((s) => !seen.has(s));
    if (rows.length > 0 && waiting.length === 0 && missing.length === 0) return;

    const status = [
      ...waiting.map((c) => `${c.service}: ${c.health ?? c.state}`),
      ...missing.map((s) => `${s}: not created`),
    ].join(", ");
    if (status !== last) {
      ctx.logs.append(r.previewId, "system", `waiting for ${status || "containers"}`);
      last = status;
    }
    if (Date.now() >= deadline)
      throw new StepFailed(
        `timed out after ${Math.round(ctx.timings.startTimeoutMs / 1000)}s waiting for ${status || "containers"}`,
      );
    await sleep(ctx.timings.pollIntervalMs);
  }
}

/** Running is not listening. Do not call it awake until the URL would actually work. */
export async function waitAnswering(ctx: PreviewContext, r: WaitTarget): Promise<void> {
  const deadline = Date.now() + ctx.timings.probeTimeoutMs;
  let pending = [...r.routes];
  for (;;) {
    r.signal.throwIfAborted();
    const results = await Promise.all(
      pending.map((route) => ctx.probe(route, r.host, r.health?.[route.service])),
    );
    pending = pending.filter((_, i) => !results[i]);
    if (pending.length === 0) return;
    if (Date.now() >= deadline) {
      throw new StepFailed(
        `${pending.map((p) => `${p.service}:${p.containerPort}${r.health?.[p.service] ?? ""}`).join(", ")} never answered${r.health && pending.some((p) => r.health![p.service]) ? " with a 2xx/3xx" : " HTTP"} -- is that the right port, and does the app listen on 0.0.0.0?`,
      );
    }
    await sleep(ctx.timings.pollIntervalMs);
  }
}

/**
 * A failed stack is torn down -- it is holding ports and memory on a box that runs real
 * workloads -- but its last words are kept first, because the container logs are the
 * only thing that says why, and the failure page shows them.
 */
export async function salvage(
  ctx: PreviewContext,
  r: Pick<RunInput, "preview" | "host">,
): Promise<void> {
  const empty = await mkdtemp(join(tmpdir(), "gangway-salvage-"));
  try {
    const logs = await ctx.compose.capture(
      composeArgv({
        project: r.preview.project,
        files: [],
        command: "logs",
        args: ["--no-color", "--tail", "60"],
        docker: ctx.docker,
      }),
      r.host,
      { cwd: empty },
    );
    if (logs.stdout) ctx.logs.append(r.preview.id, "stdout", logs.stdout);
    // Volumes stay: a failed rebuild must not take the add-on's data. Destroy removes them.
    await ctx.compose.capture(
      downArgv(
        { project: r.preview.project, files: [], docker: ctx.docker },
        [],
        rmiFor(r.preview),
        { volumes: false },
      ),
      r.host,
      { cwd: empty },
    );
  } catch (e) {
    ctx.logger.warn("could not tear down a failed stack; the reconciler will", {
      previewId: r.preview.id,
      err: e,
    });
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
}
