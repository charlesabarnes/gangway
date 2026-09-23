/**
 * Which template a deploy follows (ADR-0013), and which project it belongs to (ADR-0014).
 *
 * The project: named outright by the request, else found from the source's repository (a
 * PR by full name, a git clone URL by the name inside it). The template: named by the
 * request, else the project's, else the trigger's default from settings -- a pull
 * request, a session user at the Deploy screen, or a token (CI, a script, an agent). A
 * setting that names a template which no longer exists resolves to `default` and says so
 * once in the log.
 */
import type { Project, Template, Trigger } from "../../../shared/src/domain.ts";
import type { Actor } from "../auth/actor.ts";
import { AppError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { DeploySource } from "./deploy.ts";

export type PolicyInput = {
  source: DeploySource;
  actor: Actor;
  template?: string | undefined;
  projectId?: string | undefined;
};
export type ResolvedPolicy = { template: Template; project: Project | undefined; trigger: Trigger };

export interface Policy {
  resolve(input: PolicyInput): ResolvedPolicy;
  /** The built-in template: the sweep's window for rows deployed before templates existed. */
  default(): Template;
}

export type PolicyDeps = {
  templates: { get(id: string): Template | undefined; default(): Template };
  /** A project by id or slug, for a request that names one. */
  project: (ref: string) => Project | undefined;
  /** The project whose repository the source is; undefined when it has none. */
  projectForSource: (source: DeploySource) => Project | undefined;
  /** The trigger defaults from settings, read on every deploy. */
  defaultFor: (trigger: Trigger) => string;
  logger?: Logger | undefined;
};

export const triggerOf = (source: DeploySource, actor: Actor): Trigger =>
  source.kind === "pr" || source.kind === "pushed"
    ? "pr"
    : actor.kind === "user"
      ? "manual"
      : "api";

export class PolicyResolver implements Policy {
  readonly #d: PolicyDeps;
  readonly #warned = new Set<string>();

  constructor(d: PolicyDeps) {
    this.#d = d;
  }

  resolve(input: PolicyInput): ResolvedPolicy {
    const trigger = triggerOf(input.source, input.actor);
    let project: Project | undefined;
    if (input.projectId !== undefined) {
      project = this.#d.project(input.projectId);
      if (!project)
        throw new AppError("unprocessable", `no such project: ${input.projectId}`, {
          project: input.projectId,
        });
    } else {
      project = this.#d.projectForSource(input.source);
    }
    if (input.template !== undefined) {
      const named = this.#d.templates.get(input.template);
      if (!named)
        throw new AppError("unprocessable", `no such template: ${input.template}`, {
          template: input.template,
        });
      return { template: named, project, trigger };
    }
    const wanted = project?.templateId ?? this.#d.defaultFor(trigger);
    const found = this.#d.templates.get(wanted);
    if (found) return { template: found, project, trigger };
    // A stale name: the project's template was deleted (ON DELETE SET NULL should have
    // caught it) or a setting points nowhere. Never fail a deploy for that.
    if (!this.#warned.has(wanted)) {
      this.#warned.add(wanted);
      this.#d.logger?.warn("template not found; deploying with the default template", {
        template: wanted,
        trigger,
        project: project?.slug,
      });
    }
    return { template: this.#d.templates.default(), project, trigger };
  }

  default(): Template {
    return this.#d.templates.default();
  }
}

/** For tests and tools that need no database: one template for everything, no projects. */
export function fixedPolicy(
  fields: Partial<Omit<Template, "id" | "createdAt" | "updatedAt">> = {},
): Policy {
  const template: Template = {
    id: "default",
    name: "Default",
    description: "",
    builtin: true,
    visibility: "unlisted",
    ttl: "7d",
    idleAfter: "never",
    clearance: "standard",
    hostId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...fields,
  };
  return {
    resolve: (input) => ({
      template,
      project: undefined,
      trigger: triggerOf(input.source, input.actor),
    }),
    default: () => template,
  };
}
