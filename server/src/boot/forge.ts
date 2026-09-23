import { GitHubApp } from "../forge/github/app.ts";
import { GitHubForge } from "../forge/github/forge.ts";
import { Hooks } from "../forge/hooks.ts";
import { PrPreviews } from "../forge/pr-previews.ts";
import type { PreviewContext } from "../previews/context.ts";
import { deploy, urlsFor } from "../previews/deploy.ts";
import { destroy } from "../previews/destroy.ts";
import { Pulls, type PullsDeps } from "../projects/pulls.ts";
import { SETTINGS } from "../settings.ts";
import type { PreviewWiring } from "./context.ts";
import type { Core } from "./core.ts";

export type ForgeWiring = { githubApp: GitHubApp; hooks: Hooks; pulls: Pulls };

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
      setForgeRefs: (id, refs) => ctx.previews.setForgeRefs(id, refs),
    },
    logUrlFor: (id) =>
      settings.get(SETTINGS.surfacesUi) ? `${core.origin("app")}/previews/${id}` : undefined,
  });
  const hooks = new Hooks({ forge, service: prPreviews, logger: logger.child({ mod: "hooks" }) });
  const pulls = new Pulls({ projects: repos.projects, previews: actions });
  return { githubApp, hooks, pulls };
}

function previewActions(ctx: PreviewContext): PullsDeps["previews"] {
  return {
    deploy: (input) => deploy(ctx, input),
    destroy: (id, actor) => destroy(ctx, id, actor),
    findPullRequest: (repo, number) => ctx.previews.findPullRequest(repo, number),
  };
}
