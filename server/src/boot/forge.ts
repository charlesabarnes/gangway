import { GitHubApp } from "../forge/github/app.ts";
import { GitHubForge } from "../forge/github/forge.ts";
import { Hooks } from "../forge/hooks.ts";
import { PrPreviews } from "../forge/pr-previews.ts";
import type { PreviewContext } from "../previews/context.ts";
import { deploy, urlsFor } from "../previews/deploy.ts";
import { destroy } from "../previews/destroy.ts";
import { redeploy } from "../previews/redeploy.ts";
import { Branches } from "../projects/branches.ts";
import { deployHostOf } from "../projects/deploy-host.ts";
import { Pulls, type PullsDeps } from "../projects/pulls.ts";
import { SETTINGS } from "../settings.ts";
import type { PreviewWiring } from "./context.ts";
import type { Core } from "./core.ts";

export type ForgeWiring = { githubApp: GitHubApp; hooks: Hooks; pulls: Pulls; branches: Branches };

export function createForge(
  core: Core,
  { ctx, policy, secrets }: Pick<PreviewWiring, "ctx" | "policy" | "secrets">,
): ForgeWiring {
  const { settings, logger, repos } = core;
  const githubApp = new GitHubApp({
    credentials: () => ({
      appId: settings.get(SETTINGS.githubAppId),
      privateKey: settings.get(SETTINGS.githubPrivateKey),
    }),
    log: logger.child({ mod: "github" }),
  });
  const forge = new GitHubForge({
    app: githubApp,
    webhookSecret: () => settings.get(SETTINGS.githubWebhookSecret),
  });
  const actions = previewActions(ctx);
  const prPreviews = new PrPreviews({
    forge,
    repos: repos.projects,
    instance: core.config.instanceId,
    logger: logger.child({ mod: "pr" }),
    policy,
    secretsFor: (repo, clearance) => secrets.valuesFor(repo.id, clearance),
    previews: {
      ...actions,
      urls: (id) => urlsFor(ctx, id),
      forgeRefs: (id) => ctx.previews.forgeRefs(id),
      setForgeRefs: (id, refs) => {
        ctx.previews.setForgeRefs(id, refs);
      },
    },
    logUrlFor: (id) =>
      settings.get(SETTINGS.surfacesUi) ? `${core.origin("app")}/previews/${id}` : undefined,
  });
  const hooks = new Hooks({ forge, service: prPreviews, logger: logger.child({ mod: "hooks" }) });
  const pulls = new Pulls({ projects: repos.projects, previews: actions });
  const branches = new Branches({
    projects: repos.projects,
    previews: {
      ...actions,
      get: (id) => ctx.previews.get(id),
      list: (f) => ctx.previews.list(f),
      redeploy: (input) => redeploy(ctx, input),
    },
    audit: ctx.audit,
    labelFor: (project) => deployHostOf(project, core.domains.resolve({ project })).label,
    refreshDomains: () => {
      core.domains.refresh();
    },
  });
  return { githubApp, hooks, pulls, branches };
}

function previewActions(ctx: PreviewContext): PullsDeps["previews"] {
  return {
    deploy: (input) => deploy(ctx, input),
    destroy: (id, actor) => destroy(ctx, id, actor),
    findPullRequest: (repo, number) => ctx.previews.findPullRequest(repo, number),
    sealedSecrets: (id) => ctx.previews.envCiphertext(id),
  };
}
