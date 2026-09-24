import type { AppPlan } from "@gangway/shared/app-plan";
import type {
  BrandChoice,
  Host,
  NetworkChoice,
  Preview,
  PreviewSource,
} from "@gangway/shared/domain";
import { actorId } from "../auth/actor.ts";
import { conflict, unprocessable } from "../errors.ts";
import { addonServices } from "./addons.ts";
import type { ComposeModel } from "./compose-model.ts";
import { selectExposed } from "./compose-routes.ts";
import type { PlannedRoute } from "./planned-route.ts";
import type { PreviewContext } from "./context.ts";
import { brandField, brandFor, networkField } from "./deploy-source.ts";
import { prepareUpload, type PreparedUpload } from "./prepare-upload.ts";
import type { RedeployInput } from "./redeploy-input.ts";
import type { RuntimeChoice } from "./runtimes.ts";
import { applyEdits } from "./source-edits.ts";
import type { SourceStore } from "./source/store.ts";
import { extractTarball } from "./source/tarball.ts";
import type { Workdir } from "./source/workdir.ts";
import { servable, servesHere, siteModel } from "./site.ts";
import { readModel, type Planned } from "./stack-file.ts";

type TarballPreviewSource = Extract<PreviewSource, { kind: "tarball" }>;

async function stageSource(
  ctx: PreviewContext,
  input: RedeployInput,
  sources: SourceStore,
  wd: Workdir,
): Promise<void> {
  const id = input.previewId;
  if (input.change.kind === "replace") {
    const r = await extractTarball(input.change.archive, wd.srcDir);
    ctx.logs.append(
      id,
      "system",
      `rebuilding from a new upload (requested by ${actorId(input.actor)}): ${r.files} files, ${r.totalBytes} bytes`,
    );
    return;
  }
  await sources.copyTo(id, wd.srcDir);
  const n = await applyEdits(wd.srcDir, input.change.files);
  ctx.logs.append(
    id,
    "system",
    `rebuilding with ${n} edited file${n === 1 ? "" : "s"} (requested by ${actorId(input.actor)})`,
  );
}

function assertSameExposure(routes: PlannedRoute[], model: ComposeModel): void {
  const want = new Set(routes.map((r) => `${r.service}:${r.containerPort}`));
  const got = new Set(selectExposed(model).map((e) => `${e.service}:${e.containerPort}`));
  if (want.size !== got.size || [...want].some((k) => !got.has(k))) {
    throw unprocessable(
      "the new source exposes different services or ports than this preview; deploy it as a new preview instead",
      {
        expected: [...want].sort(),
        got: [...got].sort(),
      },
    );
  }
}

async function recordSource(
  ctx: PreviewContext,
  sources: SourceStore,
  id: string,
  source: TarballPreviewSource,
  up: PreparedUpload,
  network?: NetworkChoice,
  brand?: BrandChoice,
): Promise<PreviewSource> {
  if (up.pristine) await sources.adopt(id, up.pristine);
  const next: PreviewSource = {
    kind: "tarball",
    uploadId: source.uploadId,
    ...(up.runtime ? { runtime: up.runtime } : {}),
    ...(up.plan.addons.length ? { addons: up.plan.addons } : {}),
    ...networkField(network ?? source.network),
    ...brandField(brand ?? source.brand),
    // A preview moving onto gangway's file server is marked once its files are published.
    ...(source.serve ? { serve: source.serve } : {}),
  };
  if (JSON.stringify(next) !== JSON.stringify(source)) ctx.previews.setSource(id, next);
  return next;
}

export type Rebuild = {
  input: RedeployInput;
  sources: SourceStore;
  preview: Preview;
  host: Host;
  wd: Workdir;
  routes: PlannedRoute[];
};

export type RebuildPlan = {
  planned: Planned;
  next: PreviewSource;
  addonServices: string[];
  app: AppPlan;
  /** The plan gangway serves as files, or null when a container runs the rebuilt preview. */
  site: AppPlan | null;
  brand: boolean;
};

function siteFor(ctx: PreviewContext, source: TarballPreviewSource, plan: AppPlan): AppPlan | null {
  if (source.serve !== "gangway") return servesHere(ctx, plan) ? plan : null;
  if (servable(plan)) return plan;
  throw unprocessable(
    "gangway serves this preview as files, and the new source needs a container to run it; deploy it as a new preview instead",
  );
}

export async function planRebuild(ctx: PreviewContext, b: Rebuild): Promise<RebuildPlan> {
  const { input, preview, routes, wd } = b;
  const id = preview.id;
  const source = preview.source as TarballPreviewSource;
  if (routes.length === 0) throw conflict("the preview has no routes to rebuild behind");
  await stageSource(ctx, input, b.sources, wd);
  const choice: RuntimeChoice = input.runtime ?? "auto";
  const env =
    preview.secretLevel === null || preview.secretLevel === "none"
      ? {}
      : ctx.secretsFor?.(preview.projectId, preview.secretLevel);
  const port = routes.length === 1 ? routes[0]!.containerPort : undefined;
  const brand = brandFor(ctx, input.brand ?? source.brand);
  const up = await prepareUpload(ctx, id, wd, choice, env, port, {
    previous: source.runtime ?? "own",
    addons: input.addons,
    previousAddons: source.addons,
    brand,
  });
  const site = siteFor(ctx, source, up.plan);
  const planned = site
    ? siteModel(site, port)
    : await readModel(ctx, b.host, wd, up.composeFile, up.dotenv);
  assertSameExposure(routes, planned.model);
  const next = await recordSource(ctx, b.sources, id, source, up, input.network, input.brand);
  return { planned, next, addonServices: addonServices(up.plan.addons), app: up.plan, site, brand };
}
