import type { Clearance, RepoProject, Preview } from "@gangway/shared/domain";
import type { Actor } from "../auth/actor.ts";
import type { ProjectsRepo } from "../db/repos/projects.ts";
import type { Logger } from "../logger.ts";
import type { DeployInput, DeployResult, PreviewUrl } from "../previews/deploy-types.ts";
import type { Policy } from "../previews/policy.ts";
import type { Forge } from "./forge.ts";

export type ForgeRefs = { commentId: number | null; deploymentId: number | null };

export type PrPreviewsDeps = {
  forge: Forge;
  repos: ProjectsRepo;
  instance: string;
  previews: {
    deploy(input: DeployInput): Promise<DeployResult>;
    destroy(id: string, actor: Actor): Promise<Preview>;
    findPullRequest(repo: string, number: number): Preview | undefined;
    urls(id: string): PreviewUrl[];
    forgeRefs(id: string): ForgeRefs;
    setForgeRefs(
      id: string,
      refs: { commentId?: number | null; deploymentId?: number | null },
    ): void;
  };
  secretsFor?: ((repo: RepoProject, clearance: Clearance) => Record<string, string>) | undefined;
  policy: Policy;
  logUrlFor?: ((previewId: string) => string | undefined) | undefined;
  logger: Logger;
  now?: (() => number) | undefined;
};
