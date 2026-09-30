import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { guideText, type ArtifactKind } from "@gangway/shared/artifact/index";
import { must } from "@gangway/shared/must";
import { BUILTIN_LIBRARY } from "../artifacts/library.ts";
import type { Permission } from "@gangway/shared/permissions";
import { can, mayDestroy, mayReadLogs, mayRebuild, type Actor } from "../auth/actor.ts";
import { AppError, unprocessable } from "../errors.ts";
import { destroy } from "../previews/destroy.ts";
import { runtimeLogs, type RuntimeLogs } from "../previews/runtime-logs.ts";
import { DeployTool } from "./deploy-tool.ts";
import { describePreview, localNote, logTail, refusalDetail } from "./describe.ts";
import { connectProject } from "./project-tool.ts";
import { setSecrets } from "./secrets-tool.ts";
import { DOMAINS_TOOL, manageDomains, type DomainsArgs } from "./domains-tool.ts";
import { manageShare, SHARE_TOOL, type ShareArgs } from "./share-tool.ts";
import { extend, EXTEND_TOOL, type ExtendArgs } from "./extend-tool.ts";
import { saveTheme } from "./theme-tool.ts";
import { artifactPrompt, INSTRUCTIONS } from "./guide.ts";
import { nameOf, resolveFor, visibleTo } from "./resolve.ts";
import {
  MissingPermission,
  need,
  REDEPLOY_PERMISSION,
  TOOL_PERMISSIONS,
  type ToolName,
} from "./tool-access.ts";
import {
  CATALOG_TOOL,
  DEPLOY_TOOL,
  DESTROY_TOOL,
  GENERATE_ARTIFACT_PROMPT,
  LOGS_TOOL,
  STATUS_TOOL,
  type DeployArgs,
  type LogSource,
} from "./tool-specs.ts";
import {
  PROJECT_TOOL,
  SECRETS_TOOL,
  THEME_TOOL,
  type ProjectArgs,
  type SecretsArgs,
  type ThemeArgs,
} from "./setup-tool-specs.ts";
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
          if (token !== undefined) {
            void c.mcpReq
              .notify({
                method: "notifications/progress",
                params: { progressToken: token, progress, message },
              })
              .catch(() => {});
          }
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
    s.registerTool("catalog", CATALOG_TOOL, (args) =>
      this.#guard("catalog", () => this.catalog(scope, args.kind, args.template)),
    );
    s.registerTool("project", PROJECT_TOOL, (args) =>
      this.#guard("project", () => this.project(scope, args)),
    );
    s.registerTool("theme", THEME_TOOL, (args) =>
      this.#guard("theme", () => this.theme(scope, args)),
    );
    s.registerTool("secrets", SECRETS_TOOL, (args) =>
      this.#guard("secrets", () => this.secrets(scope, args)),
    );
    s.registerTool("domains", DOMAINS_TOOL, (args) =>
      this.#guard("domains", () => this.domains(scope, args)),
    );
    s.registerTool("share", SHARE_TOOL, (args) =>
      this.#guard("share", () => this.share(scope, args)),
    );
    s.registerTool("extend", EXTEND_TOOL, (args) =>
      this.#guard("extend", () => this.extend(scope, args)),
    );
    return s;
  }

  missingFor(actor: Actor, tool: string, args: unknown): Permission | null {
    const base = (TOOL_PERMISSIONS as Record<string, readonly Permission[]>)[tool];
    if (!base) {
      return null;
    }
    if (!base.some((p) => can(actor, p))) {
      return must(base[0], "a tool's permission");
    }
    const ref = tool === "deploy" ? (args as { preview?: unknown } | null)?.preview : undefined;
    if (typeof ref !== "string" || can(actor, REDEPLOY_PERMISSION)) {
      return null;
    }
    let id: string;
    try {
      id = resolveFor(this.#d.ctx, actor, ref).id;
    } catch {
      return null;
    }
    return mayRebuild(actor, this.#d.ctx.previews.provenanceOf(id)) ? null : REDEPLOY_PERMISSION;
  }

  async #guard(tool: ToolName, run: () => string | Promise<string>): Promise<CallToolResult> {
    try {
      return text(await run());
    } catch (err) {
      if (err instanceof MissingPermission) {
        return failure(`${tool} refused: ${err.message}`);
      }
      if (err instanceof AppError) {
        return failure(`${tool} refused: ${err.message}${refusalDetail(err.detail)}`);
      }
      if (err instanceof z.ZodError) {
        const issues = err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`);
        return failure(`${tool} refused: ${issues.join("; ")}`);
      }
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

  catalog(scope: CallScope, kind: ArtifactKind, template?: string): string {
    need(scope.actor, ...TOOL_PERMISSIONS.catalog);
    const lib = this.#d.ctx.artifacts ?? BUILTIN_LIBRARY;
    const all = lib.templates(kind);
    const id = template ?? all[0]?.id;
    if (id === undefined) {
      throw unprocessable(`no ${kind} templates on this server`);
    }
    if (!all.some((t) => t.id === id)) {
      throw unprocessable(`no ${kind} template "${id}"; one of ${all.map((x) => x.id).join(", ")}`);
    }
    const example = Object.entries(lib.render({ template: id }))
      .map(([path, body]) => `--- ${path}\n${body.trimEnd()}`)
      .join("\n");
    return `${guideText(kind)}\n\n## Themes on this server\nName one with theme: <id> in the front matter, or artifact.theme; leave it out for the default.\n${lib.themesText()}\n\n## Templates for a ${kind}\nDeploy one with deploy artifact: {template, title, subtitle, mode, theme, accent, options}, or change these files and deploy them.\n${lib.templatesText(kind)}\n\n## The ${id} template's files\n${example}`;
  }

  project(scope: CallScope, args: ProjectArgs): string {
    if (!can(scope.actor, "repos.manage")) {
      throw new MissingPermission(
        "repos.manage",
        "reconnect gangway (in Claude Code: /mcp, then re-authenticate) and grant the projects scope",
      );
    }
    return connectProject(this.#d, scope.actor, args);
  }

  theme(scope: CallScope, args: ThemeArgs): string {
    if (!can(scope.actor, "artifacts.manage")) {
      throw new MissingPermission(
        "artifacts.manage",
        "reconnect gangway (in Claude Code: /mcp, then re-authenticate) and grant the themes scope",
      );
    }
    return saveTheme(this.#d, scope.actor, args);
  }

  secrets(scope: CallScope, args: SecretsArgs): string {
    if (!can(scope.actor, "previews.secrets") && !can(scope.actor, "repos.secrets")) {
      throw new MissingPermission(
        "previews.secrets",
        "reconnect gangway (in Claude Code: /mcp, then re-authenticate) and grant the secrets scope, choosing where it may set them",
      );
    }
    return setSecrets(this.#d, scope.actor, args);
  }

  domains(scope: CallScope, args: DomainsArgs): Promise<string> {
    need(scope.actor, ...TOOL_PERMISSIONS.domains);
    return manageDomains(this.#d, scope.actor, args);
  }

  share(scope: CallScope, args: ShareArgs): Promise<string> {
    need(scope.actor, ...TOOL_PERMISSIONS.share);
    return manageShare(this.#d, scope.actor, args);
  }

  extend(scope: CallScope, args: ExtendArgs): string {
    need(scope.actor, ...TOOL_PERMISSIONS.extend);
    return extend(this.#d, scope.actor, args);
  }

  async status(scope: CallScope, ref: string | undefined): Promise<string> {
    const { ctx } = this.#d;
    need(scope.actor, ...TOOL_PERMISSIONS.status);
    if (ref !== undefined) {
      const p = resolveFor(ctx, scope.actor, ref);
      const keep = p.ttlExpiresAt ? "\nThe extend tool keeps it longer if the user asks." : "";
      return describePreview(ctx, p) + localNote(ctx, p) + keep;
    }
    const visible = visibleTo(ctx, scope.actor);
    const all = ctx.previews.list({}).filter((p) => p.state !== "destroyed" && visible(p));
    if (all.length === 0) {
      return "no previews";
    }
    const shown = all.slice(0, 50).map((p) => describePreview(ctx, p));
    const more = all.length > 50 ? `\n… and ${all.length - 50} more` : "";
    return `${all.length} preview${all.length === 1 ? "" : "s"}:\n${shown.join("\n")}${more}`;
  }

  async logs(
    scope: CallScope,
    ref: string,
    lines: number,
    opts: { source?: LogSource | undefined; service?: string | undefined } = {},
  ): Promise<string> {
    const { ctx } = this.#d;
    need(scope.actor, ...TOOL_PERMISSIONS.logs);
    const p = resolveFor(ctx, scope.actor, ref);
    if (!mayReadLogs(scope.actor, ctx.previews.provenanceOf(p.id))) {
      throw new MissingPermission("logs.read", `${nameOf(ctx, p)} is not one you deployed`);
    }
    const n = Math.min(500, Math.max(1, lines));
    const source = opts.source ?? (opts.service === undefined ? "all" : "runtime");
    const parts = [describePreview(ctx, p)];
    if (source !== "runtime") {
      parts.push(`pipeline (build, start, gangway):\n${logTail(ctx, p.id, n)}`);
    }
    if (source !== "pipeline") {
      const rt = await runtimeLogs(ctx, p, { tail: n, service: opts.service });
      const body = runtimeText(rt);
      const only = opts.service ? `, ${opts.service} only` : "";
      parts.push(`runtime (what the containers print${only}):\n${body}`);
    }
    return parts.join("\n\n");
  }

  async destroy(scope: CallScope, ref: string): Promise<string> {
    const { ctx } = this.#d;
    need(scope.actor, ...TOOL_PERMISSIONS.destroy);
    const p = resolveFor(ctx, scope.actor, ref);
    if (!mayDestroy(scope.actor, ctx.previews.provenanceOf(p.id))) {
      throw new MissingPermission(
        "previews.destroy",
        `${nameOf(ctx, p)} was deployed by someone else, and "previews.destroy_own" covers only your own`,
      );
    }
    await destroy(ctx, p.id, scope.actor);
    return `destroyed ${nameOf(ctx, p)}`;
  }
}

function runtimeText(rt: RuntimeLogs): string {
  if (rt.lines === null) {
    return `(${rt.why})`;
  }
  return rt.lines.length === 0 ? "(nothing printed yet)" : rt.lines.join("\n");
}
