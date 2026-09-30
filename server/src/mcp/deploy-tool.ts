import { addonQuery } from "@gangway/shared/api";
import type { Preview } from "@gangway/shared/domain";
import { can, mayRebuild, type Actor } from "../auth/actor.ts";
import { unprocessable } from "../errors.ts";
import { urlsFor } from "../previews/deploy-names.ts";
import type { DeploySource } from "../previews/deploy-types.ts";
import { requestHash } from "../previews/idempotent.ts";
import type { RedeployInput } from "../previews/redeploy-input.ts";
import { setPreviewWatermark } from "../previews/watermark.ts";
import { setPreviewDomain } from "../previews/domain.ts";
import { redeploy } from "../previews/redeploy.ts";
import {
  checkRebuildArgs,
  deployInput,
  iconOf,
  missingLabels,
  rebuildAsked,
  secretsAsked,
  sourcesGiven,
  templateFiles,
  type Addons,
} from "./deploy-args.ts";
import { deployReport } from "./deploy-report.ts";
import { describePreview, localNote, logTail } from "./describe.ts";
import { packFiles } from "./pack.ts";
import { nameOf, resolveFor } from "./resolve.ts";
import { secretTarget, secretUploads } from "./secrets-tool.ts";
import { changeSecrets } from "../secrets/change.ts";
import {
  MissingPermission,
  need,
  REDEPLOY_OWN_PERMISSION,
  REDEPLOY_PERMISSION,
  TOOL_PERMISSIONS,
} from "./tool-access.ts";
import { DEFAULT_WAIT_S, type DeployArgs } from "./tool-specs.ts";
import type { CallScope, ToolDeps } from "./tool-deps.ts";
import type { Taken, Uploads } from "./uploads.ts";

const FAIL_TAIL = 20;

type Sourced = { source: DeploySource; taken?: Taken };

async function waitFor<T>(
  done: Promise<T>,
  seconds: number,
  signal: AbortSignal,
): Promise<T | null> {
  if (seconds <= 0 || signal.aborted) {
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      done,
      new Promise<null>((r) => {
        timer = setTimeout(() => {
          r(null);
        }, seconds * 1000);
      }),
      new Promise<null>((r) => {
        onAbort = () => {
          r(null);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export class DeployTool {
  readonly #d: ToolDeps;

  constructor(d: ToolDeps) {
    this.#d = d;
  }

  async deploy(
    scope: CallScope,
    args: DeployArgs,
    progress: (n: number, message: string) => void,
  ): Promise<string> {
    const { ctx } = this.#d;
    need(scope.actor, ...TOOL_PERMISSIONS.deploy);
    const wait = args.waitSeconds ?? DEFAULT_WAIT_S;
    const addons = args.addons === undefined ? undefined : addonQuery.parse(args.addons.join(","));

    if (args.upload === "new") {
      return this.#issueUpload(scope, args);
    }
    if (args.preview !== undefined) {
      return this.#redeploy(scope, args, wait, addons);
    }
    if (args.remove !== undefined) {
      throw unprocessable("remove only goes with preview");
    }

    if (sourcesGiven(args) !== 1) {
      throw unprocessable("give exactly one of artifact, files, upload, image or git");
    }
    if (args.unsetSecrets !== undefined) {
      throw unprocessable("unsetSecrets only goes with preview: a new preview has none to remove");
    }
    const secrets = this.#newSecrets(scope.actor, args);
    const { source, taken } = await this.#source(scope, args, addons);
    const input = deployInput(scope, args, source, secrets);
    // Agents retry, so without a key an identical request is treated as the retry.
    const key = args.idempotencyKey ?? `auto:${requestHash(input).slice(0, 40)}`;
    const res = await this.#d.deploys.deploy(input, key).finally(() => taken?.done());
    progress(0, `${res.preview.state}: ${nameOf(ctx, res.preview)}`);

    const done = await waitFor(res.done, wait, scope.signal);
    const primary = urlsFor(ctx, res.preview.id)[0]?.url ?? res.urls[0]?.url ?? "(no URL)";
    const again = res.replayed ? " (the same preview an earlier identical call made)" : "";
    if (done === null) {
      const now = ctx.previews.get(res.preview.id) ?? res.preview;
      if (scope.signal.aborted) {
        return `stopped waiting: the MCP surface was switched off. The deploy carries on: ${primary} (${now.state})`;
      }
      return `still ${now.state} after ${wait}s: ${primary}${again}\nCall status with preview "${nameOf(ctx, now)}" to see when it is ready, or logs to watch the build.`;
    }
    if (done.state === "failed") {
      return `failed: ${done.error ?? "the deploy failed"}${again}\n\nlast log lines:\n${logTail(ctx, done.id, FAIL_TAIL)}`;
    }
    return `ready: ${primary}${again}\n${describePreview(ctx, done)}${localNote(ctx, done)}${await deployReport(ctx, done, res.plan, args.check)}${missingLabels(args)}`;
  }

  async #source(scope: CallScope, args: DeployArgs, addons: Addons | undefined): Promise<Sourced> {
    const extra = {
      ...(args.port === undefined ? {} : { port: args.port }),
      ...(addons === undefined ? {} : { addons }),
      ...(args.network === undefined ? {} : { network: args.network }),
    };
    if (args.upload !== undefined) {
      const taken = this.#take(args.upload, scope.actor);
      const { archive, digest } = taken;
      return { source: { kind: "tarball", archive, digest, runtime: "auto", ...extra }, taken };
    }
    const files =
      args.files ??
      (args.artifact ? templateFiles(this.#d.ctx.artifacts, args.artifact) : undefined);
    if (files) {
      const { archive, digest } = await packFiles(files);
      return { source: { kind: "tarball", archive, digest, runtime: "auto", ...extra } };
    }
    if (addons !== undefined) {
      throw unprocessable("addons go with files; an image or a repository brings its own stack");
    }
    if (args.image) {
      if (args.port === undefined) {
        throw unprocessable("an image needs port: the port it listens on inside the container");
      }
      const net = args.network === undefined ? {} : { network: args.network };
      return { source: { kind: "image", image: args.image, port: args.port, ...net } };
    }
    if (!args.git) {
      throw unprocessable("give exactly one of artifact, files, upload, image or git");
    }
    const git = { kind: "git" as const, repo: args.git.repo, ref: args.git.ref };
    return { source: { ...git, ...(args.port === undefined ? {} : { port: args.port }) } };
  }

  async #redeploy(
    scope: CallScope,
    args: DeployArgs,
    wait: number,
    addons: Addons | undefined,
  ): Promise<string> {
    const { ctx } = this.#d;
    if (!can(scope.actor, REDEPLOY_PERMISSION)) {
      need(scope.actor, REDEPLOY_OWN_PERMISSION);
    }
    checkRebuildArgs(args);
    if (args.preview === undefined) {
      throw unprocessable("a rebuild needs preview: the preview to rebuild");
    }
    const target = resolveFor(ctx, scope.actor, args.preview);
    if (!mayRebuild(scope.actor, ctx.previews.provenanceOf(target.id))) {
      throw new MissingPermission(
        REDEPLOY_PERMISSION,
        `${nameOf(ctx, target)} was deployed by someone else, and "previews.update_own" covers only your own. Deploy the change as a new preview instead, or ask for the update scope`,
      );
    }
    const labelled = this.#label(scope.actor, target, args);
    const secretsChanged = this.#storeSecrets(scope.actor, target, args);
    if (secretsChanged && target.source.kind !== "tarball" && !rebuildAsked(args, addons)) {
      return `secrets stored on ${nameOf(ctx, target)}: ${secretsChanged}. A ${target.source.kind} preview is not rebuilt in place; they take effect when it is deployed again.`;
    }
    if (labelled && !secretsChanged && !rebuildAsked(args, addons)) {
      return `relabelled (no rebuild): ${describePreview(ctx, ctx.previews.get(target.id) ?? target)}`;
    }
    const { change, taken } = this.#change(scope.actor, args, addons, secretsChanged !== null);
    const res = await redeploy(ctx, {
      actor: scope.actor,
      previewId: target.id,
      change,
      ...(addons === undefined ? {} : { addons }),
      ...(args.network === undefined ? {} : { network: args.network }),
    }).finally(() => taken?.done());
    const outcome = await waitFor(res.done, wait, scope.signal);
    const url = urlsFor(ctx, target.id)[0]?.url ?? "(no URL)";
    if (outcome === null) {
      return `still rebuilding after ${wait}s: ${url}\nThe previous version keeps serving until the new one is up. Call status to check.`;
    }
    if (outcome.outcome === "failed") {
      return `rebuild failed: ${outcome.error ?? "the build failed"}\n${outcome.preview.state === "awake" ? "The previous version is still serving." : describePreview(ctx, outcome.preview)}\n\nlast log lines:\n${logTail(ctx, target.id, FAIL_TAIL)}`;
    }
    return `ready: ${url} (rebuilt)\n${describePreview(ctx, outcome.preview)}${await deployReport(ctx, outcome.preview, res.plan, args.check)}`;
  }

  /** Sets a title, icon, watermark or domain given with preview; a domain moves on its next rebuild. */
  #label(actor: Actor, target: Preview, args: DeployArgs): boolean {
    const { ctx } = this.#d;
    const icon = iconOf(args);
    if (args.title !== undefined) {
      ctx.previews.setTitle(target.id, args.title);
      ctx.audit.record(actor, "preview.title", target.id, { old: target.title, new: args.title });
    }
    if (icon) {
      ctx.previews.setIcon(target.id, icon);
      ctx.audit.record(actor, "preview.icon", target.id, { old: target.icon, new: icon });
    }
    if (args.watermark !== undefined) {
      setPreviewWatermark(ctx, actor, target.id, args.watermark);
    }
    if (args.domain !== undefined) {
      setPreviewDomain(ctx, actor, target.id, args.domain);
    }
    return [args.title, icon, args.watermark, args.domain].some((x) => x !== undefined);
  }

  /** Secrets sent with a new deploy: they need previews.secrets, and are the new preview's own. */
  #newSecrets(actor: Actor, args: DeployArgs): Record<string, string> | undefined {
    if (!secretsAsked(args)) {
      return undefined;
    }
    if (!can(actor, "previews.secrets")) {
      throw new MissingPermission(
        "previews.secrets",
        "setting secrets needs the secrets scope: reconnect gangway (in Claude Code: /mcp) and grant it",
      );
    }
    const uploaded = args.secretsUpload
      ? secretUploads(this.#d).take(args.secretsUpload, actor)
      : {};
    return { ...uploaded, ...args.secrets };
  }

  /** Secrets sent with a rebuild go onto the preview first; returns the names changed, or null. */
  #storeSecrets(actor: Actor, target: Preview, args: DeployArgs): string | null {
    if (!secretsAsked(args)) {
      return null;
    }
    const { ctx } = this.#d;
    if (!ctx.secrets) {
      throw unprocessable("secrets are not available on this server");
    }
    const where = secretTarget(this.#d, actor, { preview: target.id });
    const uploaded = args.secretsUpload
      ? secretUploads(this.#d).take(args.secretsUpload, actor)
      : {};
    const set = { ...uploaded, ...args.secrets };
    const unset = args.unsetSecrets ?? [];
    if (Object.keys(set).length === 0 && unset.length === 0) {
      return "none";
    }
    changeSecrets({ secrets: ctx.secrets, previews: ctx.previews }, actor, where, {
      ...(Object.keys(set).length > 0 ? { set } : {}),
      ...(unset.length > 0 ? { unset } : {}),
    });
    return [...Object.keys(set).map((k) => `${k} set`), ...unset.map((k) => `${k} removed`)].join(
      ", ",
    );
  }

  #change(
    actor: Actor,
    args: DeployArgs,
    addons: Addons | undefined,
    secretsOnly = false,
  ): { change: RedeployInput["change"]; taken?: Taken } {
    if (args.upload !== undefined) {
      const taken = this.#take(args.upload, actor);
      return { change: { kind: "replace", archive: taken.archive }, taken };
    }
    const files: Record<string, string | null> = {
      ...(args.artifact ? templateFiles(this.#d.ctx.artifacts, args.artifact) : (args.files ?? {})),
    };
    for (const p of args.remove ?? []) {
      files[p] = null;
    }
    const settingOnly = args.network !== undefined || secretsOnly;
    if (Object.keys(files).length === 0 && addons === undefined && !settingOnly) {
      throw unprocessable("nothing to change: give files, remove, upload or addons");
    }
    return { change: { kind: "edit", files } };
  }

  #uploads(): Uploads {
    if (!this.#d.uploads) {
      throw unprocessable("uploads are not available on this server; send files instead");
    }
    return this.#d.uploads;
  }

  #take(id: string, actor: Actor): Taken {
    if (id === "new") {
      throw unprocessable(
        'upload: "new" asks for an upload URL; deploy from it with the id it returns',
      );
    }
    return this.#uploads().take(id, actor);
  }

  #issueUpload(scope: CallScope, args: DeployArgs): string {
    const others = (["files", "image", "git", "remove"] as const).filter(
      (k) => args[k] !== undefined,
    );
    if (others.length > 0) {
      throw unprocessable(
        `upload: "new" only asks for a URL; ${others.join(", ")} go with the deploy that follows`,
      );
    }
    const u = this.#uploads().issue(scope.actor);
    const mins = Math.round((u.expiresAt - this.#d.ctx.now()) / 60_000);
    return [
      `upload URL ready: one use, ${mins} min, at most ${Math.floor(u.maxBytes / 1024 / 1024)} MiB. From the app's directory:`,
      "",
      `  COPYFILE_DISABLE=1 tar --exclude=.git --exclude=node_modules -czf - . | curl -sS --fail-with-body -X PUT -H 'content-type: application/gzip' --data-binary @- '${u.url}'`,
      "",
      `Then: deploy with upload: "${u.id}" and the usual name, title, icon, addons -- or with preview: "<name>" as well, to replace that preview's source and rebuild it at the same URL.`,
    ].join("\n");
  }
}
