import type { Clearance, Host, Preview, Visibility, PasswordLogin } from "@gangway/shared/domain";
import type { AddonRequest, AppPlan } from "@gangway/shared/app-plan";
import type { PasswordChoice } from "@gangway/shared/api";
import { actorId, type Actor } from "../auth/actor.ts";
import { unprocessable } from "../errors.ts";
import { place } from "../scheduler/placement.ts";
import { parseDuration } from "../util/duration.ts";
import { ulid } from "../util/ulid.ts";
import type { ComposeModel } from "./compose-model.ts";
import { selectExposed, type PlannedRoute } from "./compose-routes.ts";
import type { PreviewContext } from "./context.ts";
import { claimPreview } from "./deploy-claim.ts";
import { urlsFor } from "./deploy-names.ts";
import { writeSource, type Materialized } from "./deploy-source.ts";
import { logGenerated, resolvePassword } from "./password.ts";
import {
  buildImages,
  failStack,
  failureMessage,
  openPipeline,
  runJob,
  startStack,
  waitTargetFor,
  type RunPlan,
} from "./pipeline.ts";
import type { ResolvedPolicy } from "./policy.ts";
import type { RuntimeChoice } from "./runtimes.ts";
import type { TarballSource } from "./source/tarball.ts";
import type { Workdir } from "./source/workdir.ts";
import { readModel, writeStack, type Planned } from "./stack-file.ts";
import { releaseFor, seedFor } from "./steps.ts";
import { waitAnswering, waitHealthy } from "./wait.ts";

export { urlsFor };

export type DeploySource =
  | { kind: "image"; image: string; port: number; env?: Record<string, string> | undefined }
  | { kind: "git"; repo: string; ref: string; port?: number | undefined }
  | {
      kind: "pr";
      repo: string;
      number: number;
      sha: string;
      cloneUrl: string;
      credential: string | undefined;
      port?: number | undefined;
    }
  | {
      kind: "tarball";
      archive: TarballSource;
      port?: number | undefined;
      digest?: string | undefined;
      runtime?: RuntimeChoice | undefined;
      addons?: readonly AddonRequest[] | undefined;
    }
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
  env?: Record<string, string> | undefined;
  secretLevel?: Clearance | undefined;
  name?: string | undefined;
  visibility?: Visibility | undefined;
  ttl?: string | null | undefined;
  hostId?: string | undefined;
  template?: string | undefined;
  projectId?: string | undefined;
  password?: PasswordChoice | undefined;
  passwordLogin?: PasswordLogin | undefined;
};

export type PreviewUrl = { service: string; url: string; primary: boolean };

export type DeployResult = {
  preview: Preview;
  urls: PreviewUrl[];
  done: Promise<Preview>;
  plan?: AppPlan | undefined;
};

type Template = ResolvedPolicy["template"];
type Owner = ResolvedPolicy["project"];

function resolveHost(ctx: PreviewContext, input: DeployInput, template: Template): Host {
  const allHosts = ctx.hosts.list();
  let wantedHost = input.hostId ?? template.hostId ?? undefined;
  if (
    input.hostId === undefined &&
    template.hostId !== null &&
    !allHosts.some((h) => h.id === template.hostId)
  ) {
    ctx.logger.warn(
      "template names a host that does not exist; letting the scheduler place the preview",
      { template: template.id, hostId: template.hostId },
    );
    wantedHost = undefined;
  }
  return place({ capability: "preview", hostId: wantedHost }, allHosts);
}

function envFor(
  ctx: PreviewContext,
  input: DeployInput,
  owner: Owner,
  secretLevel: Clearance,
): Record<string, string> | undefined {
  if (input.env !== undefined) return input.env;
  if (secretLevel === "none") return {};
  return ctx.secretsFor?.(owner?.id ?? null, secretLevel);
}

function visibilityFor(
  ctx: PreviewContext,
  input: DeployInput,
  { template, project: owner }: ResolvedPolicy,
  model: ComposeModel,
): Visibility {
  const visibility =
    input.visibility ?? owner?.visibility ?? model.x.visibility ?? template.visibility;
  if (
    (visibility === "private" || input.passwordLogin === "only") &&
    ctx.privateAvailable?.() === false
  ) {
    throw unprocessable(
      "private previews need the web UI, which is switched off (surfaces.ui); use unlisted instead",
    );
  }
  return visibility;
}

function ttlFor(
  input: DeployInput,
  { template, project: owner }: ResolvedPolicy,
  model: ComposeModel,
): number | null {
  const ttlText = input.ttl !== undefined ? input.ttl : (owner?.ttl ?? model.x.ttl ?? template.ttl);
  const ttlMs = ttlText === null ? null : parseDuration(ttlText);
  if (ttlText !== null && ttlMs === null)
    throw unprocessable(`ttl ${JSON.stringify(ttlText)} is not a duration like 12h or 7d`);
  return ttlMs;
}

type Prepared = {
  preview: Preview;
  routes: PlannedRoute[];
  planned: Planned;
  material: Materialized;
  visibility: Visibility;
  generatedPassword: string | undefined;
};

async function prepare(
  ctx: PreviewContext,
  input: DeployInput,
  id: string,
  host: Host,
  wd: Workdir,
  policy: ResolvedPolicy,
): Promise<Prepared> {
  const { template, project: owner } = policy;
  const secretLevel: Clearance = input.secretLevel ?? owner?.prClearance ?? template.clearance;
  const env = envFor(ctx, input, owner, secretLevel);
  const material = await writeSource(ctx, id, input.source, env, wd);
  const planned = await readModel(ctx, host, wd, material.composeFile);
  const { model } = planned;
  const exposed = selectExposed(model);
  const visibility = visibilityFor(ctx, input, policy, model);
  const ttlMs = ttlFor(input, policy, model);
  const password = await resolvePassword(ctx.passwords, input.password);
  const { preview, routes } = claimPreview(ctx, {
    id,
    input,
    policy,
    host,
    model,
    exposed,
    source: material.source,
    runtime: material.runtime ?? null,
    visibility,
    ttlMs,
    secretLevel,
    password,
  });
  return { preview, routes, planned, material, visibility, generatedPassword: password.generated };
}

async function keepUpload(ctx: PreviewContext, id: string, pristine: string | null | undefined) {
  if (!pristine || !ctx.sources) return;
  await ctx.sources
    .adopt(id, pristine)
    .catch((e) => ctx.logger.warn("could not keep the uploaded source", { previewId: id, err: e }));
}

function announce(ctx: PreviewContext, input: DeployInput, host: Host, p: Prepared): PreviewUrl[] {
  const { preview } = p;
  const id = preview.id;
  const urls = urlsFor(ctx, id);
  ctx.bus.publish(
    "preview.created",
    { project: preview.project, by: actorId(input.actor), urls: urls.map((u) => u.url) },
    id,
  );
  ctx.logs.append(id, "system", `deploying ${preview.project} to host ${host.id}`);
  if (p.generatedPassword) logGenerated(ctx, id, p.generatedPassword);
  ctx.audit.record(input.actor, "preview.deploy", id, {
    new: {
      project: preview.project,
      visibility: p.visibility,
      passwordMode: preview.password,
      source: input.source.kind,
      hostId: host.id,
      urls: urls.map((u) => u.url),
    },
  });
  return urls;
}

export async function deploy(ctx: PreviewContext, input: DeployInput): Promise<DeployResult> {
  const id = ulid(ctx.now());
  const policy = ctx.policy.resolve({
    source: input.source,
    actor: input.actor,
    template: input.template,
    projectId: input.projectId,
  });
  const host = resolveHost(ctx, input, policy.template);
  const wd = await ctx.workdirs.create(id);

  let p: Prepared;
  try {
    p = await prepare(ctx, input, id, host, wd, policy);
  } catch (e) {
    await wd.cleanup();
    ctx.logs.remove(id);
    throw e;
  }

  await keepUpload(ctx, id, p.material.pristine);
  const urls = announce(ctx, input, host, p);

  const abort = new AbortController();
  const done = run(ctx, {
    preview: p.preview,
    host,
    wd,
    ...p.planned,
    routes: p.routes,
    visibility: p.visibility,
    dockerConfig: p.material.dockerConfig,
    signal: abort.signal,
  }).finally(() => {
    ctx.inflight.delete(id);
  });
  ctx.inflight.set(id, { abort, done });

  return { preview: p.preview, urls, done, plan: p.material.plan };
}

type DeployRun = RunPlan & { dockerConfig?: string | undefined };

async function run(ctx: PreviewContext, r: DeployRun): Promise<Preview> {
  const p = openPipeline(ctx, r);
  let upAttempted = false;
  try {
    await writeStack(ctx, p.stackPath, r);
    await buildImages(ctx, p, r);

    ctx.states.transition(p.id, "starting");
    upAttempted = true;
    await startStack(p, r.dockerConfig);

    const target = waitTargetFor(p, r);
    await waitHealthy(ctx, target);
    await runJob(p, "release", releaseFor(r.model, r.routes));
    await runJob(p, "seed", seedFor(r.model, r.routes));
    await waitAnswering(ctx, target);

    p.log("awake");
    return ctx.states.transition(p.id, "awake");
  } catch (e) {
    // destroy() aborted the run and owns the preview from here.
    if (r.signal.aborted) return ctx.previews.get(p.id) ?? r.preview;

    const message = failureMessage(ctx, p.id, e, "deploy pipeline error");
    return await failStack(ctx, r, message, upAttempted);
  } finally {
    await r.wd.cleanup();
  }
}
