import type { Project, Template, Trigger } from "@gangway/shared/domain";
import type { Actor } from "../auth/actor.ts";
import { AppError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { DeploySource } from "./deploy-types.ts";

export type PolicyInput = {
  source: DeploySource;
  actor: Actor;
  template?: string | undefined;
  projectId?: string | undefined;
};
export type ResolvedPolicy = { template: Template; project: Project | undefined; trigger: Trigger };

export interface Policy {
  resolve(input: PolicyInput): ResolvedPolicy;
  default(): Template;
}

export type PolicyDeps = {
  templates: { get(id: string): Template | undefined; default(): Template };
  project: (ref: string) => Project | undefined;
  projectForSource: (source: DeploySource) => Project | undefined;
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
