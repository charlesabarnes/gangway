import type { Project } from "@gangway/shared/domain";
import type { Actor } from "../auth/actor.ts";
import type { ArtifactThemesRepo } from "../db/repos/artifacts.ts";
import type { ProjectsRepo } from "../db/repos/projects.ts";
import type { TemplatesRepo } from "../db/repos/templates.ts";
import type { Logger } from "../logger.ts";
import type { PreviewContext } from "../previews/context.ts";
import type { IdempotentDeploys } from "../previews/idempotent.ts";
import type { Settings } from "../settings.ts";
import type { SecretUploads } from "./secret-uploads.ts";
import type { Uploads } from "./uploads.ts";

export type ToolDeps = {
  ctx: PreviewContext;
  deploys: IdempotentDeploys;
  logger: Logger;
  uploads?: Uploads | undefined;
  secretUploads?: SecretUploads | undefined;
  /** For secret targets: finding a project by slug. */
  findProject?: ((ref: string) => Project | undefined) | undefined;
  /** For the project tool; without it the tool answers that projects are not available. */
  projects?:
    | {
        repo: ProjectsRepo;
        templates?: Pick<TemplatesRepo, "get"> | undefined;
        apiOrigin: () => string;
      }
    | undefined;
  /** For the theme tool, with ctx.artifacts. */
  themes?: { themes: ArtifactThemesRepo; settings: Settings } | undefined;
};

export type CallScope = { actor: Actor; signal: AbortSignal };
