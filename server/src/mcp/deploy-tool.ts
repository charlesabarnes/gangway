import { addonQuery } from "@gangway/shared/api";
import type { Preview } from "@gangway/shared/domain";
import type { AppPlan } from "@gangway/shared/app-plan";
import { can, mayRebuild, type Actor } from "../auth/actor.ts";
import { unprocessable } from "../errors.ts";
import { urlsFor } from "../previews/deploy-names.ts";
import type { DeploySource } from "../previews/deploy-types.ts";
import { requestHash } from "../previews/idempotent.ts";
import type { RedeployInput } from "../previews/redeploy-input.ts";
import { redeploy } from "../previews/redeploy.ts";
import { httpStatus } from "../previews/probe.ts";
import { describePlan, describePreview, logTail } from "./describe.ts";
import { packFiles } from "./pack.ts";
import { nameOf, resolvePreview } from "./resolve.ts";
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
const MANIFEST_SHOWN = 40;

type Addons = ReturnType<typeof addonQuery.parse>;
type Sourced = { source: DeploySource; taken?: Taken };

async function waitFor<T>(
  done: Promise<T>,
  seconds: number,
  signal: AbortSignal,
): Promise<T | null> {
  if (seconds <= 0 || signal.aborted) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      done,
      new Promise<null>((r) => {
        timer = setTimeout(() => r(null), seconds * 1000);
      }),
      new Promise<null>((r) => {
        onAbort = () => r(null);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function checkRebuildArgs(args: DeployArgs): void {
  if (args.image !== undefined || args.git !== undefined)
    throw unprocessable(
      "preview rebuilds from files or an upload; an image or a repository is a new deploy",
    );
  if (args.upload !== undefined && (args.files !== undefined || args.remove !== undefined))
    throw unprocessable(
      "upload replaces the whole source; files and remove edit it -- give one or the other",
    );
}

function sourcesGiven(args: DeployArgs): number {
  return [
    args.files !== undefined,
    args.upload !== undefined,
    args.image !== undefined,
    args.git !== undefined,
  ].filter(Boolean).length;
}

function deployInput(scope: CallScope, args: DeployArgs, source: DeploySource) {
  return {
    actor: scope.actor,
    source,
    name: args.name,
    visibility: args.visibility,
    ttl: args.ttl,
    template: args.template,
    projectId: args.project,
    ...(args.password ? { password: { mode: args.password } } : {}),
    ...(args.passwordLogin ? { passwordLogin: args.passwordLogin } : {}),
  };
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
    need(scope.actor, TOOL_PERMISSIONS.deploy);
    const wait = args.waitSeconds ?? DEFAULT_WAIT_S;
    const addons = args.addons === undefined ? undefined : addonQuery.parse(args.addons.join(","));

    if (args.upload === "new") return this.#issueUpload(scope, args);
    if (args.preview !== undefined) return this.#redeploy(scope, args, wait, addons);
    if (args.remove !== undefined) throw unprocessable("remove only goes with preview");

    if (sourcesGiven(args) !== 1)
      throw unprocessable("give exactly one of files, upload, image or git");
    const { source, taken } = await this.#source(scope, args, addons);
    const input = deployInput(scope, args, source);
    // Agents retry, so without a key an identical request is treated as the retry.
    const key = args.idempotencyKey ?? `auto:${requestHash(input).slice(0, 40)}`;
    const res = await this.#d.deploys.deploy(input, key).finally(() => taken?.done());
    progress(0, `${res.preview.state}: ${nameOf(ctx, res.preview)}`);

    const done = await waitFor(res.done, wait, scope.signal);
    const primary = urlsFor(ctx, res.preview.id)[0]?.url ?? res.urls[0]?.url ?? "(no URL)";
    const again = res.replayed ? " (the same preview an earlier identical call made)" : "";
    if (done === null) {
      const now = ctx.previews.get(res.preview.id) ?? res.preview;
      if (scope.signal.aborted)
        return `stopped waiting: the MCP surface was switched off. The deploy carries on: ${primary} (${now.state})`;
      return `still ${now.state} after ${wait}s: ${primary}${again}\nCall status with preview "${nameOf(ctx, now)}" to see when it is ready, or logs to watch the build.`;
    }
    if (done.state === "failed") {
      return `failed: ${done.error ?? "the deploy failed"}${again}\n\nlast log lines:\n${logTail(ctx, done.id, FAIL_TAIL)}`;
    }
    return `ready: ${primary}${again}\n${describePreview(ctx, done)}${await this.#report(done, res.plan, args.check)}`;
  }

  async #source(scope: CallScope, args: DeployArgs, addons: Addons | undefined): Promise<Sourced> {
    const extra = {
      ...(args.port === undefined ? {} : { port: args.port }),
      ...(addons === undefined ? {} : { addons }),
    };
    if (args.upload !== undefined) {
      const taken = this.#take(args.upload, scope.actor);
      const { archive, digest } = taken;
      return { source: { kind: "tarball", archive, digest, runtime: "auto", ...extra }, taken };
    }
    if (args.files) {
      const { archive, digest } = await packFiles(args.files);
      return { source: { kind: "tarball", archive, digest, runtime: "auto", ...extra } };
    }
    if (addons !== undefined)
      throw unprocessable("addons go with files; an image or a repository brings its own stack");
    if (args.image) {
      if (args.port === undefined)
        throw unprocessable("an image needs port: the port it listens on inside the container");
      return { source: { kind: "image", image: args.image, port: args.port } };
    }
    const git = { kind: "git" as const, repo: args.git!.repo, ref: args.git!.ref };
    return { source: { ...git, ...(args.port === undefined ? {} : { port: args.port }) } };
  }

  async #redeploy(
    scope: CallScope,
    args: DeployArgs,
    wait: number,
    addons: Addons | undefined,
  ): Promise<string> {
    const { ctx } = this.#d;
    if (!can(scope.actor, REDEPLOY_PERMISSION)) need(scope.actor, REDEPLOY_OWN_PERMISSION);
    checkRebuildArgs(args);
    const target = resolvePreview(ctx, args.preview!);
    if (!mayRebuild(scope.actor, ctx.previews.ownerOf(target.id))) {
      throw new MissingPermission(
        REDEPLOY_PERMISSION,
        `${nameOf(ctx, target)} was deployed by someone else, and "previews.update_own" covers only your own. Deploy the change as a new preview instead, or ask for the update scope`,
      );
    }
    const { change, taken } = this.#change(scope.actor, args, addons);
    const res = await redeploy(ctx, {
      actor: scope.actor,
      previewId: target.id,
      change,
      ...(addons === undefined ? {} : { addons }),
    }).finally(() => taken?.done());
    const outcome = await waitFor(res.done, wait, scope.signal);
    const url = urlsFor(ctx, target.id)[0]?.url ?? "(no URL)";
    if (outcome === null)
      return `still rebuilding after ${wait}s: ${url}\nThe previous version keeps serving until the new one is up. Call status to check.`;
    if (outcome.outcome === "failed") {
      return `rebuild failed: ${outcome.error ?? "the build failed"}\n${outcome.preview.state === "awake" ? "The previous version is still serving." : describePreview(ctx, outcome.preview)}\n\nlast log lines:\n${logTail(ctx, target.id, FAIL_TAIL)}`;
    }
    return `ready: ${url} (rebuilt)\n${describePreview(ctx, outcome.preview)}${await this.#report(outcome.preview, res.plan, args.check)}`;
  }

  #change(
    actor: Actor,
    args: DeployArgs,
    addons: Addons | undefined,
  ): { change: RedeployInput["change"]; taken?: Taken } {
    if (args.upload !== undefined) {
      const taken = this.#take(args.upload, actor);
      return { change: { kind: "replace", archive: taken.archive }, taken };
    }
    const files: Record<string, string | null> = { ...(args.files ?? {}) };
    for (const p of args.remove ?? []) files[p] = null;
    if (Object.keys(files).length === 0 && addons === undefined)
      throw unprocessable("nothing to change: give files, remove, upload or addons");
    return { change: { kind: "edit", files } };
  }

  async #report(
    p: Preview,
    plan: AppPlan | undefined,
    check: readonly string[] | undefined,
  ): Promise<string> {
    const out: string[] = [];
    if (plan) out.push(describePlan(plan));
    const manifest = await this.#manifest(p);
    if (manifest) out.push(manifest);
    if (check && check.length > 0) {
      const checked = await this.#check(p, check);
      if (checked) out.push(checked);
    }
    return out.length === 0 ? "" : `\n${out.join("\n")}`;
  }

  async #manifest(p: Preview): Promise<string | null> {
    const { ctx } = this.#d;
    if (!ctx.sources || p.source.kind !== "tarball" || !(await ctx.sources.has(p.id))) return null;
    const m = await ctx.sources.manifest(p.id);
    if (m.files.length > MANIFEST_SHOWN)
      return `files as deployed: ${m.files.length}${m.truncated ? "+" : ""} (too many to list; the preview page shows them)`;
    return `files as deployed (sha256, first 12 hex; compare with shasum -a 256):\n${m.files.map((f) => `  ${f.sha256.slice(0, 12)}  ${String(f.bytes).padStart(8)}  ${f.path}`).join("\n")}`;
  }

  async #check(p: Preview, check: readonly string[]): Promise<string | null> {
    const { ctx } = this.#d;
    const route =
      ctx.table.forPreview(p.id).find((e) => e.primary) ?? ctx.table.forPreview(p.id)[0];
    const host = ctx.hosts.get(p.hostId);
    if (!route || !host) return null;
    const probe = ctx.statusProbe ?? httpStatus;
    const target = {
      hostname: route.hostname,
      upstream: { host: route.upstreamHost, port: route.upstreamPort },
    };
    const got = await Promise.all(
      check.map(async (path) => `${path} ${(await probe(target, host, path)) ?? "no answer"}`),
    );
    return `checked: ${got.join(" · ")}`;
  }

  #uploads(): Uploads {
    if (!this.#d.uploads)
      throw unprocessable("uploads are not available on this server; send files instead");
    return this.#d.uploads;
  }

  #take(id: string, actor: Actor): Taken {
    if (id === "new")
      throw unprocessable(
        'upload: "new" asks for an upload URL; deploy from it with the id it returns',
      );
    return this.#uploads().take(id, actor);
  }

  #issueUpload(scope: CallScope, args: DeployArgs): string {
    const others = (["files", "image", "git", "remove"] as const).filter(
      (k) => args[k] !== undefined,
    );
    if (others.length > 0)
      throw unprocessable(
        `upload: "new" only asks for a URL; ${others.join(", ")} go with the deploy that follows`,
      );
    const u = this.#uploads().issue(scope.actor);
    const mins = Math.round((u.expiresAt - this.#d.ctx.now()) / 60_000);
    return [
      `upload URL ready: one use, ${mins} min, at most ${Math.floor(u.maxBytes / 1024 / 1024)} MiB. From the app's directory:`,
      "",
      `  COPYFILE_DISABLE=1 tar --exclude=.git --exclude=node_modules -czf - . | curl -sS --fail-with-body -X PUT -H 'content-type: application/gzip' --data-binary @- '${u.url}'`,
      "",
      `Then: deploy with upload: "${u.id}" and the usual name, visibility, addons -- or with preview: "<name>" as well, to replace that preview's source and rebuild it at the same URL.`,
    ].join("\n");
  }
}
