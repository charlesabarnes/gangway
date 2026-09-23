import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Permission } from "@gangway/shared/permissions";
import { can, mayRebuild, type Actor } from "../auth/actor.ts";
import { AppError } from "../errors.ts";
import { destroy } from "../previews/destroy.ts";
import { runtimeLogs } from "../previews/runtime-logs.ts";
import { DeployTool } from "./deploy-tool.ts";
import { describePreview, logTail, refusalDetail } from "./describe.ts";
import { artifactPrompt, INSTRUCTIONS } from "./guide.ts";
import { nameOf, resolvePreview } from "./resolve.ts";
import {
  MissingPermission,
  need,
  REDEPLOY_PERMISSION,
  TOOL_PERMISSIONS,
  type ToolName,
} from "./tool-access.ts";
import {
  DEPLOY_TOOL,
  DESTROY_TOOL,
  GENERATE_ARTIFACT_PROMPT,
  LOGS_TOOL,
  STATUS_TOOL,
  type DeployArgs,
  type LogSource,
} from "./tool-specs.ts";
import type { CallScope, ToolDeps } from "./tool-deps.ts";

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
const failure = (t: string): CallToolResult => ({
  content: [{ type: "text", text: t }],
  isError: true,
});

export class Tools {
  readonly #d: ToolDeps;
  readonly #deployTool: DeployTool;

  constructor(d: ToolDeps) {
    this.#d = d;
    this.#deployTool = new DeployTool(d);
  }

  server(scope: CallScope): McpServer {
    const s = new McpServer({ name: "gangway", version: "1" }, { instructions: INSTRUCTIONS });
    s.registerPrompt("generate-artifact", GENERATE_ARTIFACT_PROMPT, (args) => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: artifactPrompt(args.what) },
        },
      ],
    }));
    s.registerTool("deploy", DEPLOY_TOOL, (args, c) =>
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
    s.registerTool("status", STATUS_TOOL, (args) =>
      this.#guard("status", () => this.status(scope, args.preview)),
    );
    s.registerTool("logs", LOGS_TOOL, (args) =>
      this.#guard("logs", () =>
        this.logs(scope, args.preview, args.lines ?? 80, {
          source: args.source,
          service: args.service,
        }),
      ),
    );
    s.registerTool("destroy", DESTROY_TOOL, (args) =>
      this.#guard("destroy", () => this.destroy(scope, args.preview)),
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

  deploy(
    scope: CallScope,
    args: DeployArgs,
    progress: (n: number, message: string) => void = () => {},
  ): Promise<string> {
    return this.#deployTool.deploy(scope, args, progress);
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
