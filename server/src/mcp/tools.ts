import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { addonQuery, VISIBILITY_VALUES } from "@gangway/shared/api";
import type { Preview } from "@gangway/shared/domain";
import type { Permission } from "@gangway/shared/permissions";
import { can, mayRebuild, type Actor } from "../auth/actor.ts";
import { AppError, unprocessable } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { PreviewContext } from "../previews/context.ts";
import { destroy } from "../previews/destroy.ts";
import { urlsFor, type DeploySource } from "../previews/deploy.ts";
import { type IdempotentDeploys, requestHash } from "../previews/idempotent.ts";
import { redeploy, type RedeployInput } from "../previews/redeploy.ts";
import type { Taken, Uploads } from "./uploads.ts";
import { runtimeLogs } from "../previews/runtime-logs.ts";
import { CHECK_PATH, httpStatus } from "../previews/probe.ts";
import { cmdText, type AppPlan } from "@gangway/shared/app-plan";
import { artifactPrompt, INSTRUCTIONS } from "./guide.ts";
import { nameOf, resolvePreview } from "./resolve.ts";
import { packFiles } from "./pack.ts";

export const TOOL_PERMISSIONS = {
  deploy: "previews.deploy",
  status: "previews.read",
  logs: "logs.read",
  destroy: "previews.destroy",
} as const satisfies Record<string, Permission>;
export type ToolName = keyof typeof TOOL_PERMISSIONS;
const REDEPLOY_PERMISSION: Permission = "previews.update";
const REDEPLOY_OWN_PERMISSION: Permission = "previews.update_own";

const DEFAULT_WAIT_S = 240;
const MAX_WAIT_S = 600;
const FAIL_TAIL = 20;
const MAX_CHECKS = 20;
const MANIFEST_SHOWN = 40;
const PLAN_REASONS_SHOWN = 8;

class MissingPermission extends Error {
  readonly permission: Permission;
  constructor(permission: Permission, why?: string) {
    super(`this credential lacks the "${permission}" permission${why ? `: ${why}` : ""}`);
    this.permission = permission;
  }
}

export type ToolDeps = {
  ctx: PreviewContext;
  deploys: IdempotentDeploys;
  logger: Logger;
  uploads?: Uploads | undefined;
};

export type CallScope = { actor: Actor; signal: AbortSignal };

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
const failure = (t: string): CallToolResult => ({
  content: [{ type: "text", text: t }],
  isError: true,
});

function need(actor: Actor, p: Permission): void {
  if (!can(actor, p)) throw new MissingPermission(p);
}

function inTime(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function describePreview(ctx: PreviewContext, p: Preview): string {
  const urls = urlsFor(ctx, p.id).map((u) => u.url);
  const parts = [`${nameOf(ctx, p)}: ${p.state}`];
  if (urls.length > 0) parts.push(urls.join(" "));
  if (p.state === "asleep") parts.push("(wakes on the first visit)");
  if (p.ttlExpiresAt !== null)
    parts.push(`expires in ${inTime(p.ttlExpiresAt.getTime() - ctx.now())}`);
  if (p.state === "failed" && p.error) parts.push(`error: ${p.error}`);
  return parts.join(" — ");
}

export function refusalDetail(detail: Record<string, unknown> | undefined): string {
  if (!detail) return "";
  const lines: string[] = [];
  for (const r of Array.isArray(detail["reasons"])
    ? (detail["reasons"] as { level?: string; found?: string; then?: string }[])
    : []) {
    if (r.found && r.then)
      lines.push(`  ${r.level && r.level !== "info" ? `${r.level}: ` : ""}${r.found} -> ${r.then}`);
  }
  for (const i of Array.isArray(detail["issues"])
    ? (detail["issues"] as { path?: string; message?: string }[])
    : []) {
    if (i.message) lines.push(`  gangway.yml ${i.path ?? ""}: ${i.message}`);
  }
  for (const v of Array.isArray(detail["violations"]) ? (detail["violations"] as unknown[]) : [])
    lines.push(`  ${typeof v === "string" ? v : JSON.stringify(v)}`);
  if (typeof detail["compose"] === "string")
    lines.push(`  compose: ${detail["compose"].slice(-500)}`);
  return lines.length ? `\n${lines.slice(0, 20).join("\n")}` : "";
}

function describePlan(plan: AppPlan): string {
  const what =
    plan.kind === "own"
      ? "the upload's own compose file or Dockerfile"
      : `${plan.runtime}${plan.version ? ` ${plan.version}` : ""}`;
  const runs =
    plan.kind === "own"
      ? null
      : plan.start
        ? `runs \`${cmdText(plan.start)}\``
        : plan.entry
          ? `runs ${plan.entry}`
          : plan.serve.kind === "static"
            ? "the files are served by nginx"
            : null;
  const addons = plan.addons.length
    ? `add-ons: ${plan.addons.map((a) => `${a.id} ${a.version}`).join(", ")}`
    : null;
  const reasons = plan.reasons
    .slice(0, PLAN_REASONS_SHOWN)
    .map((r) => `  ${r.level === "info" ? "" : `${r.level}: `}${r.found} -> ${r.then}`);
  const more =
    plan.reasons.length > PLAN_REASONS_SHOWN
      ? [`  … ${plan.reasons.length - PLAN_REASONS_SHOWN} more in logs`]
      : [];
  return [`plan: ${[what, runs, addons].filter(Boolean).join(" — ")}`, ...reasons, ...more].join(
    "\n",
  );
}

function logTail(ctx: PreviewContext, id: string, n: number): string {
  const lines = ctx.logs.read(id).slice(-n);
  return lines.length === 0
    ? "(no log lines yet)"
    : lines.map((l) => `${l.stream}: ${l.line}`).join("\n");
}

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

const DeployArgs = z.object({
  files: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'The app as text files, path -> contents, e.g. {"index.html": "<h1>hi</h1>"}. A runtime is picked from what is there (static, node, bun, deno, python, php; a Dockerfile or compose.yaml is used as-is). Up to 1000 files, 2 MiB.',
    ),
  image: z
    .string()
    .optional()
    .describe("Instead of files: a public container image, e.g. traefik/whoami:v1.10. Needs port."),
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe("The port the image listens on inside the container."),
  git: z
    .object({
      repo: z.string().describe("An https URL on github.com"),
      ref: z.string().describe("A branch, tag or commit"),
    })
    .optional()
    .describe("Instead of files: a git repository to clone and build."),
  upload: z
    .string()
    .max(64)
    .optional()
    .describe(
      'Instead of files, for anything bigger than a page or two: "new" returns a one-use URL to PUT a .tar.gz of the app to (with curl) -- nothing is deployed yet. Then call deploy again with upload: "<the id>" and the usual options. Faster than files, and deploys exactly the bytes on disk.',
    ),
  preview: z
    .string()
    .optional()
    .describe(
      "Rebuild THIS existing preview (its name, URL or id) at the same URL. files are then changes: only the files named are written. With upload: the whole source is replaced by the upload.",
    ),
  remove: z.array(z.string()).optional().describe("With preview: paths to delete."),
  name: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe("The first label of the hostname. Defaults to one derived from the source."),
  visibility: z
    .enum(VISIBILITY_VALUES)
    .optional()
    .describe("public; unlisted (an unguessable hostname); private (visitors must log in)."),
  ttl: z
    .string()
    .max(16)
    .optional()
    .describe("How long it lives, e.g. 2h or 7d. Defaults to the server's."),
  template: z.string().optional().describe("A named server policy (visibility, ttl, host)."),
  project: z.string().optional().describe("A project slug to file the preview under."),
  passwordLogin: z
    .enum(["inherit", "on", "off", "only"])
    .optional()
    .describe(
      "Who can open it. off: anyone with the password; on: people signed in to gangway, or anyone with the password; only: only people signed in to gangway (no password); inherit follows the server.",
    ),
  password: z
    .enum(["inherit", "none", "generate"])
    .optional()
    .describe(
      "Put it behind a password: generate makes one and prints it ONLY in the preview's log (read it with logs); none leaves it open; inherit (the default) follows the server's setting.",
    ),
  addons: z
    .array(z.string())
    .optional()
    .describe(
      'Throwaway databases, e.g. ["postgres"], ["redis@8"]. Their URLs arrive as env vars (DATABASE_URL, REDIS_URL).',
    ),
  idempotencyKey: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Retry with the same key and you get the same preview, not a second one. Omitted, an identical request counts as a retry.",
    ),
  waitSeconds: z
    .number()
    .int()
    .min(0)
    .max(MAX_WAIT_S)
    .optional()
    .describe(
      `How long to wait for the URL to answer, default ${DEFAULT_WAIT_S}. 0 returns at once.`,
    ),
  check: z
    .array(z.string().regex(CHECK_PATH, "a path starting with /, no spaces"))
    .max(MAX_CHECKS)
    .optional()
    .describe(
      'Paths to GET once it answers, e.g. ["/", "/api/health"]. Each one\'s status comes back with the result, so you need not curl them.',
    ),
});
type DeployArgs = z.infer<typeof DeployArgs>;

const PreviewRef = z.string().min(1).max(2048);
const LOG_SOURCES = ["all", "pipeline", "runtime"] as const;
type LogSource = (typeof LOG_SOURCES)[number];

export class Tools {
  readonly #d: ToolDeps;

  constructor(d: ToolDeps) {
    this.#d = d;
  }

  server(scope: CallScope): McpServer {
    const s = new McpServer({ name: "gangway", version: "1" }, { instructions: INSTRUCTIONS });
    s.registerPrompt(
      "generate-artifact",
      {
        title: "Build and ship an artifact-style app",
        description:
          "Build something you would make as an artifact (a page, demo, mockups, a small app with a database) and ship it to a real URL here, the fast way.",
        argsSchema: z.object({ what: z.string().max(2000).optional().describe("What to build") }),
      },
      (args) => ({
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: artifactPrompt(args.what) },
          },
        ],
      }),
    );
    s.registerTool(
      "deploy",
      {
        title: "Deploy a preview",
        description:
          "Put an app on a public HTTPS URL: from files (the usual case), a container image, or a git repository. Waits until the URL actually answers and returns it. Also rebuilds an existing preview in place (preview + files).",
        inputSchema: DeployArgs,
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      (args, c) =>
        this.#guard("deploy", () =>
          this.deploy(scope, args, (progress, message) => {
            const token = c.mcpReq._meta?.progressToken;
            if (token !== undefined)
              void c.mcpReq
                .notify({
                  method: "notifications/progress",
                  params: { progressToken: token, progress, message },
                })
                .catch(() => {});
          }),
        ),
    );
    s.registerTool(
      "status",
      {
        title: "Preview status",
        description:
          "One preview's state, URL and expiry (by name, URL or id), or every live preview when none is named.",
        inputSchema: z.object({
          preview: PreviewRef.optional().describe("A name, URL or id. Omit to list them all."),
        }),
        annotations: { readOnlyHint: true },
      },
      (args) => this.#guard("status", () => this.status(scope, args.preview)),
    );
    s.registerTool(
      "logs",
      {
        title: "Preview logs",
        description:
          "A preview's logs: the pipeline (build, start, gangway's own lines) and the runtime (what its containers print, e.g. your server's startup line and its errors). Read this when a deploy failed or the app misbehaves.",
        inputSchema: z.object({
          preview: PreviewRef,
          lines: z
            .number()
            .int()
            .min(1)
            .max(500)
            .optional()
            .describe("How many per section, default 80."),
          source: z
            .enum(LOG_SOURCES)
            .optional()
            .describe("pipeline, runtime, or all (the default)."),
          service: z
            .string()
            .max(63)
            .optional()
            .describe("Runtime lines of one service only, e.g. web or postgres."),
        }),
        annotations: { readOnlyHint: true },
      },
      (args) =>
        this.#guard("logs", () =>
          this.logs(scope, args.preview, args.lines ?? 80, {
            source: args.source,
            service: args.service,
          }),
        ),
    );
    s.registerTool(
      "destroy",
      {
        title: "Destroy a preview",
        description:
          "Tear a preview down: its URL stops answering and its containers and data are removed.",
        inputSchema: z.object({ preview: PreviewRef }),
        annotations: { destructiveHint: true, idempotentHint: true },
      },
      (args) => this.#guard("destroy", () => this.destroy(scope, args.preview)),
    );
    return s;
  }

  missingFor(actor: Actor, tool: string, args: unknown): Permission | null {
    const base = (TOOL_PERMISSIONS as Record<string, Permission>)[tool];
    if (!base) return null;
    if (!can(actor, base)) return base;
    const ref = tool === "deploy" ? (args as { preview?: unknown } | null)?.preview : undefined;
    if (typeof ref !== "string" || can(actor, REDEPLOY_PERMISSION)) return null;
    let owner: string | null;
    try {
      owner = this.#d.ctx.previews.ownerOf(resolvePreview(this.#d.ctx, ref).id);
    } catch {
      return null;
    }
    return mayRebuild(actor, owner) ? null : REDEPLOY_PERMISSION;
  }

  async #guard(tool: ToolName, run: () => Promise<string>): Promise<CallToolResult> {
    try {
      return text(await run());
    } catch (err) {
      if (err instanceof MissingPermission) return failure(`${tool} refused: ${err.message}`);
      if (err instanceof AppError)
        return failure(`${tool} refused: ${err.message}${refusalDetail(err.detail)}`);
      if (err instanceof z.ZodError)
        return failure(
          `${tool} refused: ${err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`,
        );
      this.#d.logger.error("mcp tool failed", { tool, err });
      return failure(`${tool} failed on the server; see the gangway log`);
    }
  }

  async deploy(
    scope: CallScope,
    args: DeployArgs,
    progress: (n: number, message: string) => void = () => {},
  ): Promise<string> {
    const { ctx } = this.#d;
    need(scope.actor, TOOL_PERMISSIONS.deploy);
    const wait = args.waitSeconds ?? DEFAULT_WAIT_S;
    const addons = args.addons === undefined ? undefined : addonQuery.parse(args.addons.join(","));

    if (args.upload === "new") return this.#issueUpload(scope, args);
    if (args.preview !== undefined) return this.#redeploy(scope, args, wait, addons);
    if (args.remove !== undefined) throw unprocessable("remove only goes with preview");

    const given = [
      args.files !== undefined,
      args.upload !== undefined,
      args.image !== undefined,
      args.git !== undefined,
    ].filter(Boolean).length;
    if (given !== 1) throw unprocessable("give exactly one of files, upload, image or git");
    let source: DeploySource;
    let taken: Taken | undefined;
    if (args.upload !== undefined) {
      taken = this.#take(args.upload, scope.actor);
      source = {
        kind: "tarball",
        archive: taken.archive,
        digest: taken.digest,
        runtime: "auto",
        ...(args.port === undefined ? {} : { port: args.port }),
        ...(addons === undefined ? {} : { addons }),
      };
    } else if (args.files) {
      const { archive, digest } = await packFiles(args.files);
      source = {
        kind: "tarball",
        archive,
        digest,
        runtime: "auto",
        ...(args.port === undefined ? {} : { port: args.port }),
        ...(addons === undefined ? {} : { addons }),
      };
    } else {
      if (addons !== undefined)
        throw unprocessable("addons go with files; an image or a repository brings its own stack");
      if (args.image) {
        if (args.port === undefined)
          throw unprocessable("an image needs port: the port it listens on inside the container");
        source = { kind: "image", image: args.image, port: args.port };
      } else {
        source = {
          kind: "git",
          repo: args.git!.repo,
          ref: args.git!.ref,
          ...(args.port === undefined ? {} : { port: args.port }),
        };
      }
    }
    const input = {
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

  async #redeploy(
    scope: CallScope,
    args: DeployArgs,
    wait: number,
    addons: ReturnType<typeof addonQuery.parse> | undefined,
  ): Promise<string> {
    const { ctx } = this.#d;
    if (!can(scope.actor, REDEPLOY_PERMISSION)) need(scope.actor, REDEPLOY_OWN_PERMISSION);
    if (args.image !== undefined || args.git !== undefined)
      throw unprocessable(
        "preview rebuilds from files or an upload; an image or a repository is a new deploy",
      );
    if (args.upload !== undefined && (args.files !== undefined || args.remove !== undefined))
      throw unprocessable(
        "upload replaces the whole source; files and remove edit it -- give one or the other",
      );
    const target = resolvePreview(ctx, args.preview!);
    if (!mayRebuild(scope.actor, ctx.previews.ownerOf(target.id))) {
      throw new MissingPermission(
        REDEPLOY_PERMISSION,
        `${nameOf(ctx, target)} was deployed by someone else, and "previews.update_own" covers only your own. Deploy the change as a new preview instead, or ask for the update scope`,
      );
    }
    let change: RedeployInput["change"];
    let taken: Taken | undefined;
    if (args.upload !== undefined) {
      taken = this.#take(args.upload, scope.actor);
      change = { kind: "replace", archive: taken.archive };
    } else {
      const files: Record<string, string | null> = { ...(args.files ?? {}) };
      for (const p of args.remove ?? []) files[p] = null;
      if (Object.keys(files).length === 0 && addons === undefined)
        throw unprocessable("nothing to change: give files, remove, upload or addons");
      change = { kind: "edit", files };
    }
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

  async #report(
    p: Preview,
    plan: AppPlan | undefined,
    check: readonly string[] | undefined,
  ): Promise<string> {
    const { ctx } = this.#d;
    const out: string[] = [];
    if (plan) out.push(describePlan(plan));
    if (ctx.sources && p.source.kind === "tarball" && (await ctx.sources.has(p.id))) {
      const m = await ctx.sources.manifest(p.id);
      if (m.files.length <= MANIFEST_SHOWN) {
        out.push(
          `files as deployed (sha256, first 12 hex; compare with shasum -a 256):\n${m.files.map((f) => `  ${f.sha256.slice(0, 12)}  ${String(f.bytes).padStart(8)}  ${f.path}`).join("\n")}`,
        );
      } else {
        out.push(
          `files as deployed: ${m.files.length}${m.truncated ? "+" : ""} (too many to list; the preview page shows them)`,
        );
      }
    }
    if (check && check.length > 0) {
      const route =
        ctx.table.forPreview(p.id).find((e) => e.primary) ?? ctx.table.forPreview(p.id)[0];
      const host = ctx.hosts.get(p.hostId);
      if (route && host) {
        const probe = ctx.statusProbe ?? httpStatus;
        const target = {
          hostname: route.hostname,
          upstream: { host: route.upstreamHost, port: route.upstreamPort },
        };
        const got = await Promise.all(
          check.map(async (path) => `${path} ${(await probe(target, host, path)) ?? "no answer"}`),
        );
        out.push(`checked: ${got.join(" · ")}`);
      }
    }
    return out.length === 0 ? "" : `\n${out.join("\n")}`;
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

  async status(scope: CallScope, ref: string | undefined): Promise<string> {
    const { ctx } = this.#d;
    need(scope.actor, TOOL_PERMISSIONS.status);
    if (ref !== undefined) return describePreview(ctx, resolvePreview(ctx, ref));
    const all = ctx.previews.list({}).filter((p) => p.state !== "destroyed");
    if (all.length === 0) return "no previews";
    const shown = all.slice(0, 50).map((p) => describePreview(ctx, p));
    return `${all.length} preview${all.length === 1 ? "" : "s"}:\n${shown.join("\n")}${all.length > 50 ? `\n… and ${all.length - 50} more` : ""}`;
  }

  async logs(
    scope: CallScope,
    ref: string,
    lines: number,
    opts: { source?: LogSource | undefined; service?: string | undefined } = {},
  ): Promise<string> {
    const { ctx } = this.#d;
    need(scope.actor, TOOL_PERMISSIONS.logs);
    const p = resolvePreview(ctx, ref);
    const n = Math.min(500, Math.max(1, lines));
    const source = opts.source ?? (opts.service === undefined ? "all" : "runtime");
    const parts = [describePreview(ctx, p)];
    if (source !== "runtime")
      parts.push(`pipeline (build, start, gangway):\n${logTail(ctx, p.id, n)}`);
    if (source !== "pipeline") {
      const rt = await runtimeLogs(ctx, p, { tail: n, service: opts.service });
      const body =
        rt.lines === null
          ? `(${rt.why})`
          : rt.lines.length === 0
            ? "(nothing printed yet)"
            : rt.lines.join("\n");
      parts.push(
        `runtime (what the containers print${opts.service ? `, ${opts.service} only` : ""}):\n${body}`,
      );
    }
    return parts.join("\n\n");
  }

  async destroy(scope: CallScope, ref: string): Promise<string> {
    const { ctx } = this.#d;
    need(scope.actor, TOOL_PERMISSIONS.destroy);
    const p = resolvePreview(ctx, ref);
    await destroy(ctx, p.id, scope.actor);
    return `destroyed ${nameOf(ctx, p)}`;
  }
}
