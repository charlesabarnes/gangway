/**
 * §10.2 the MCP tools. FOUR, a hard ceiling: `deploy`, `status`, `logs`, `destroy`. A big
 * tool surface poisons an agent's context and it starts picking wrong; everything else is a
 * parameter. Each answers with a URL and a short status string -- never a JSON dump, which
 * the agent would paste into its own reasoning.
 *
 * A thin adapter over the service layer (ADR-0003), like the REST routes. There is no
 * `requirePermission` here, so each tool asks `can()` itself; `TOOL_PERMISSIONS` is pinned
 * by a test the way `route-permissions.test.ts` pins the routes.
 */
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { addonQuery, VISIBILITY_VALUES } from "../../../shared/src/api.ts";
import type { Preview } from "../../../shared/src/domain.ts";
import type { Permission } from "../../../shared/src/permissions.ts";
import { can, type Actor } from "../auth/actor.ts";
import { AppError, unprocessable } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { PreviewContext } from "../previews/context.ts";
import { destroy } from "../previews/destroy.ts";
import { urlsFor, type DeploySource } from "../previews/deploy.ts";
import type { IdempotentDeploys } from "../previews/idempotent.ts";
import { requestHash } from "../previews/idempotent.ts";
import { redeploy } from "../previews/redeploy.ts";
import { nameOf, resolvePreview } from "./resolve.ts";
import { packFiles } from "./pack.ts";

export const TOOL_PERMISSIONS = {
  deploy: "previews.deploy",
  status: "previews.read",
  logs: "logs.read",
  destroy: "previews.destroy",
} as const satisfies Record<string, Permission>;
export type ToolName = keyof typeof TOOL_PERMISSIONS;
/** `deploy` with `preview` rebuilds an existing one in place, which is its own permission (ADR-0015). */
export const REDEPLOY_PERMISSION: Permission = "previews.update";

export const DEFAULT_WAIT_S = 240;
export const MAX_WAIT_S = 600;
const FAIL_TAIL = 20;

/** Refused before the tool starts. */
export class MissingPermission extends Error {
  readonly permission: Permission;
  constructor(permission: Permission) {
    super(`this credential lacks the "${permission}" permission`);
    this.permission = permission;
  }
}

export type ToolDeps = {
  ctx: PreviewContext;
  deploys: IdempotentDeploys;
  logger: Logger;
};

/** Per call: who is asking, and the signal that fires when MCP is switched off (§10.5). */
export type CallScope = { actor: Actor; signal: AbortSignal };

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
const failure = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }], isError: true });

function need(actor: Actor, p: Permission): void {
  if (!can(actor, p)) throw new MissingPermission(p);
}

function inTime(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export function describePreview(ctx: PreviewContext, p: Preview): string {
  const urls = urlsFor(ctx, p.id).map((u) => u.url);
  const parts = [`${nameOf(ctx, p)}: ${p.state}`];
  if (urls.length > 0) parts.push(urls.join(" "));
  if (p.state === "asleep") parts.push("(wakes on the first visit)");
  if (p.ttlExpiresAt !== null) parts.push(`expires in ${inTime(p.ttlExpiresAt.getTime() - ctx.now())}`);
  if (p.state === "failed" && p.error) parts.push(`error: ${p.error}`);
  return parts.join(" — ");
}

function logTail(ctx: PreviewContext, id: string, n: number): string {
  const lines = ctx.logs.read(id).slice(-n);
  return lines.length === 0 ? "(no log lines yet)" : lines.map((l) => `${l.stream}: ${l.line}`).join("\n");
}

/** Settles with the preview, or null at the deadline or when MCP is switched off. */
async function waitFor<T>(done: Promise<T>, seconds: number, signal: AbortSignal): Promise<T | null> {
  if (seconds <= 0 || signal.aborted) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      done,
      new Promise<null>((r) => { timer = setTimeout(() => r(null), seconds * 1000); }),
      new Promise<null>((r) => { onAbort = () => r(null); signal.addEventListener("abort", onAbort, { once: true }); }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

const DeployArgs = z.object({
  files: z.record(z.string(), z.string()).optional()
    .describe("The app as text files, path -> contents, e.g. {\"index.html\": \"<h1>hi</h1>\"}. A runtime is picked from what is there (static, node, bun, deno, python, php; a Dockerfile or compose.yaml is used as-is). Up to 1000 files, 2 MiB."),
  image: z.string().optional().describe("Instead of files: a public container image, e.g. traefik/whoami:v1.10. Needs port."),
  port: z.number().int().min(1).max(65535).optional().describe("The port the image listens on inside the container."),
  git: z.object({ repo: z.string().describe("An https URL on github.com"), ref: z.string().describe("A branch, tag or commit") }).optional().describe("Instead of files: a git repository to clone and build."),
  preview: z.string().optional().describe("Rebuild THIS existing preview (its name, URL or id) at the same URL. files are then changes: only the files named are written."),
  remove: z.array(z.string()).optional().describe("With preview: paths to delete."),
  name: z.string().min(1).max(40).optional().describe("The first label of the hostname. Defaults to one derived from the source."),
  visibility: z.enum(VISIBILITY_VALUES).optional().describe("public; unlisted (an unguessable hostname); private (visitors must log in)."),
  ttl: z.string().max(16).optional().describe("How long it lives, e.g. 2h or 7d. Defaults to the server's."),
  template: z.string().optional().describe("A named server policy (visibility, ttl, host)."),
  project: z.string().optional().describe("A project slug to file the preview under."),
  addons: z.array(z.string()).optional().describe("Throwaway databases, e.g. [\"postgres\"], [\"redis@8\"]. Their URLs arrive as env vars (DATABASE_URL, REDIS_URL)."),
  idempotencyKey: z.string().min(1).max(200).optional().describe("Retry with the same key and you get the same preview, not a second one. Omitted, an identical request counts as a retry."),
  waitSeconds: z.number().int().min(0).max(MAX_WAIT_S).optional().describe(`How long to wait for the URL to answer, default ${DEFAULT_WAIT_S}. 0 returns at once.`),
});
type DeployArgs = z.infer<typeof DeployArgs>;

const PreviewRef = z.string().min(1).max(2048);

export class Tools {
  readonly #d: ToolDeps;

  constructor(d: ToolDeps) {
    this.#d = d;
  }

  /** One server per request (stateless): its tools are closed over THIS request's actor. */
  server(scope: CallScope): McpServer {
    const s = new McpServer({ name: "gangway", version: "1" }, {
      instructions: "gangway gives an app a public HTTPS URL. deploy blocks until the URL answers, then returns it. Use status to see what exists, logs when something failed, destroy when done.",
    });
    s.registerTool("deploy", {
      title: "Deploy a preview",
      description: "Put an app on a public HTTPS URL: from files (the usual case), a container image, or a git repository. Waits until the URL actually answers and returns it. Also rebuilds an existing preview in place (preview + files).",
      inputSchema: DeployArgs,
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, (args, c) => this.#guard("deploy", () => this.deploy(scope, args, (progress, message) => {
      const token = c.mcpReq._meta?.progressToken;
      if (token !== undefined) void c.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress, message } }).catch(() => {});
    })));
    s.registerTool("status", {
      title: "Preview status",
      description: "One preview's state, URL and expiry (by name, URL or id), or every live preview when none is named.",
      inputSchema: z.object({ preview: PreviewRef.optional().describe("A name, URL or id. Omit to list them all.") }),
      annotations: { readOnlyHint: true },
    }, (args) => this.#guard("status", () => this.status(scope, args.preview)));
    s.registerTool("logs", {
      title: "Preview logs",
      description: "The last lines of a preview's build and runtime log. Read this when a deploy failed.",
      inputSchema: z.object({ preview: PreviewRef, lines: z.number().int().min(1).max(500).optional().describe("How many, default 80.") }),
      annotations: { readOnlyHint: true },
    }, (args) => this.#guard("logs", () => this.logs(scope, args.preview, args.lines ?? 80)));
    s.registerTool("destroy", {
      title: "Destroy a preview",
      description: "Tear a preview down: its URL stops answering and its containers and data are removed.",
      inputSchema: z.object({ preview: PreviewRef }),
      annotations: { destructiveHint: true, idempotentHint: true },
    }, (args) => this.#guard("destroy", () => this.destroy(scope, args.preview)));
    return s;
  }

  /** A refusal or a bad request is a tool error the agent can read, never a protocol error it cannot. */
  async #guard(tool: ToolName, run: () => Promise<string>): Promise<CallToolResult> {
    try {
      return text(await run());
    } catch (err) {
      if (err instanceof MissingPermission) return failure(`${tool} refused: ${err.message}`);
      if (err instanceof AppError) return failure(`${tool} refused: ${err.message}`);
      if (err instanceof z.ZodError) return failure(`${tool} refused: ${err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
      this.#d.logger.error("mcp tool failed", { tool, err });
      return failure(`${tool} failed on the server; see the gangway log`);
    }
  }

  async deploy(scope: CallScope, args: DeployArgs, progress: (n: number, message: string) => void = () => {}): Promise<string> {
    const { ctx } = this.#d;
    need(scope.actor, TOOL_PERMISSIONS.deploy);
    const wait = args.waitSeconds ?? DEFAULT_WAIT_S;
    const addons = args.addons === undefined ? undefined : addonQuery.parse(args.addons.join(","));

    if (args.preview !== undefined) return this.#redeploy(scope, args, wait, addons);
    if (args.remove !== undefined) throw unprocessable("remove only goes with preview");

    const given = [args.files !== undefined, args.image !== undefined, args.git !== undefined].filter(Boolean).length;
    if (given !== 1) throw unprocessable("give exactly one of files, image or git");
    let source: DeploySource;
    if (args.files) {
      const { archive, digest } = await packFiles(args.files);
      source = { kind: "tarball", archive, digest, runtime: "auto", ...(args.port === undefined ? {} : { port: args.port }), ...(addons === undefined ? {} : { addons }) };
    } else {
      if (addons !== undefined) throw unprocessable("addons go with files; an image or a repository brings its own stack");
      if (args.image) {
        if (args.port === undefined) throw unprocessable("an image needs port: the port it listens on inside the container");
        source = { kind: "image", image: args.image, port: args.port };
      } else {
        source = { kind: "git", repo: args.git!.repo, ref: args.git!.ref, ...(args.port === undefined ? {} : { port: args.port }) };
      }
    }
    const input = {
      actor: scope.actor, source,
      name: args.name, visibility: args.visibility, ttl: args.ttl, template: args.template, projectId: args.project,
    };
    // §10.2: agents retry. With no key of their own, an identical request is the retry.
    const key = args.idempotencyKey ?? `auto:${requestHash(input).slice(0, 40)}`;
    const res = await this.#d.deploys.deploy(input, key);
    progress(0, `${res.preview.state}: ${nameOf(ctx, res.preview)}`);

    const done = await waitFor(res.done, wait, scope.signal);
    const primary = urlsFor(ctx, res.preview.id)[0]?.url ?? res.urls[0]?.url ?? "(no URL)";
    const again = res.replayed ? " (the same preview an earlier identical call made)" : "";
    if (done === null) {
      const now = ctx.previews.get(res.preview.id) ?? res.preview;
      if (scope.signal.aborted) return `stopped waiting: the MCP surface was switched off. The deploy carries on: ${primary} (${now.state})`;
      return `still ${now.state} after ${wait}s: ${primary}${again}\nCall status with preview "${nameOf(ctx, now)}" to see when it is ready, or logs to watch the build.`;
    }
    if (done.state === "failed") {
      return `failed: ${done.error ?? "the deploy failed"}${again}\n\nlast log lines:\n${logTail(ctx, done.id, FAIL_TAIL)}`;
    }
    return `ready: ${primary}${again}\n${describePreview(ctx, done)}`;
  }

  async #redeploy(scope: CallScope, args: DeployArgs, wait: number, addons: ReturnType<typeof addonQuery.parse> | undefined): Promise<string> {
    const { ctx } = this.#d;
    need(scope.actor, REDEPLOY_PERMISSION);
    if (args.image !== undefined || args.git !== undefined) throw unprocessable("preview rebuilds from files; an image or a repository is a new deploy");
    const target = resolvePreview(ctx, args.preview!);
    const files: Record<string, string | null> = { ...(args.files ?? {}) };
    for (const p of args.remove ?? []) files[p] = null;
    if (Object.keys(files).length === 0 && addons === undefined) throw unprocessable("nothing to change: give files, remove or addons");
    const res = await redeploy(ctx, { actor: scope.actor, previewId: target.id, change: { kind: "edit", files }, ...(addons === undefined ? {} : { addons }) });
    const outcome = await waitFor(res.done, wait, scope.signal);
    const url = urlsFor(ctx, target.id)[0]?.url ?? "(no URL)";
    if (outcome === null) return `still rebuilding after ${wait}s: ${url}\nThe previous version keeps serving until the new one is up. Call status to check.`;
    if (outcome.outcome === "failed") {
      return `rebuild failed: ${outcome.error ?? "the build failed"}\n${outcome.preview.state === "awake" ? "The previous version is still serving." : describePreview(ctx, outcome.preview)}\n\nlast log lines:\n${logTail(ctx, target.id, FAIL_TAIL)}`;
    }
    return `ready: ${url} (rebuilt)\n${describePreview(ctx, outcome.preview)}`;
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

  async logs(scope: CallScope, ref: string, lines: number): Promise<string> {
    const { ctx } = this.#d;
    need(scope.actor, TOOL_PERMISSIONS.logs);
    const p = resolvePreview(ctx, ref);
    return `${describePreview(ctx, p)}\n\n${logTail(ctx, p.id, Math.min(500, Math.max(1, lines)))}`;
  }

  async destroy(scope: CallScope, ref: string): Promise<string> {
    const { ctx } = this.#d;
    need(scope.actor, TOOL_PERMISSIONS.destroy);
    const p = resolvePreview(ctx, ref);
    await destroy(ctx, p.id, scope.actor);
    return `destroyed ${nameOf(ctx, p)}`;
  }
}
