import type { PreviewUrl } from "../previews/deploy.ts";
import type { ForgeRepo, PullRequest } from "./forge.ts";
import type { PrPreviewsDeps } from "./pr-previews.ts";

type DeploymentDeps = Pick<PrPreviewsDeps, "forge" | "logger" | "logUrlFor">;

function logUrl(d: DeploymentDeps, previewId: string): { logUrl?: string } {
  const u = d.logUrlFor?.(previewId);
  return u ? { logUrl: u } : {};
}

export async function recordDeployment(
  d: DeploymentDeps,
  pr: PullRequest,
  name: string,
  previewId: string,
): Promise<number | null> {
  let deploymentId: number | null = null;
  try {
    deploymentId = await d.forge.createDeployment(pr, `preview/${name}`);
    await d.forge.setDeploymentStatus(pr.repo, deploymentId, "in_progress", logUrl(d, previewId));
  } catch (e) {
    d.logger.warn("forge deployment not recorded", { previewId, err: e });
  }
  return deploymentId;
}

export async function finishDeployment(
  d: DeploymentDeps,
  pr: PullRequest,
  deploymentId: number,
  previewId: string,
  o: { awake: boolean; urls: PreviewUrl[] },
): Promise<void> {
  try {
    const primary = o.urls.find((u) => u.primary)?.url;
    await d.forge.setDeploymentStatus(pr.repo, deploymentId, o.awake ? "success" : "failure", {
      ...(primary ? { environmentUrl: primary } : {}),
      ...logUrl(d, previewId),
    });
  } catch (e) {
    d.logger.warn("forge deployment status not set", { previewId, err: e });
  }
}

export async function retireDeployment(
  d: Pick<DeploymentDeps, "forge" | "logger">,
  repo: ForgeRepo,
  deploymentId: number | null,
): Promise<void> {
  if (deploymentId === null) return;
  try {
    await d.forge.setDeploymentStatus(repo, deploymentId, "inactive");
  } catch (e) {
    d.logger.warn("forge deployment not retired", {
      repo: repo.fullName,
      deploymentId,
      err: e,
    });
  }
}
