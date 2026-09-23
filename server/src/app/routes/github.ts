import type { Hono } from "hono";
import { ManifestExchangeSchema } from "../../../../shared/src/api.ts";
import type { AuditSink } from "../../audit/audit.ts";
import { badRequest, conflict, unprocessable } from "../../errors.ts";
import type { GitHubApp } from "../../forge/github/app.ts";
import { buildManifest, type ManifestStates } from "../../forge/github/manifest.ts";
import { SETTINGS, type Settings } from "../../settings.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";

export type GitHubRouteDeps = {
  app: GitHubApp;
  settings: Settings;
  states: ManifestStates;
  audit: AuditSink;
  baseDomain: () => string;
  /** Public origins of the two surfaces the manifest names. */
  originFor: (label: string) => string;
};

const GITHUB_KEYS = [
  SETTINGS.githubAppId,
  SETTINGS.githubAppSlug,
  SETTINGS.githubClientId,
  SETTINGS.githubClientSecret,
  SETTINGS.githubPrivateKey,
  SETTINGS.githubWebhookSecret,
];

/**
 * `/v1/github` (§10.4, ADR-0011): is the App connected, and the manifest flow that
 * connects it. Every route needs `github.manage`; the status answer carries no secret.
 */
export function githubRoutes(api: Hono<AppEnv>, d: GitHubRouteDeps): void {
  const status = () => {
    const appId = d.settings.get(SETTINGS.githubAppId);
    const slug = d.settings.get(SETTINGS.githubAppSlug);
    const hasKey = d.settings.get(SETTINGS.githubPrivateKey) !== "";
    const hasSecret = d.settings.get(SETTINGS.githubWebhookSecret) !== "";
    return {
      configured: appId !== "" && hasKey && hasSecret,
      appId,
      appSlug: slug,
      appUrl: slug === "" ? null : `https://github.com/apps/${encodeURIComponent(slug)}`,
      installUrl:
        slug === ""
          ? null
          : `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`,
      webhookUrl: `${d.originFor("hooks")}/github`,
      missing: [
        ...(appId === "" ? ["github.appId"] : []),
        ...(hasKey ? [] : ["github.privateKey"]),
        ...(hasSecret ? [] : ["github.webhookSecret"]),
      ],
      managedByConfig: GITHUB_KEYS.some((k) => d.settings.isManagedByConfig(k.key)),
    };
  };

  api.get("/github", requirePermission("github.manage"), (c) => c.json(status()));

  // ADR-0014: what the New project form offers -- repositories the App is installed on.
  // Readable by whoever may make a project; empty (not an error) when the App is not connected.
  api.get("/github/repositories", requirePermission("repos.manage"), async (c) => {
    if (!status().configured) return c.json({ repositories: [] });
    return c.json({ repositories: await d.app.installedRepositories() });
  });

  /** The manifest and a one-time state; the UI posts the manifest to GitHub as a form. */
  api.get("/github/manifest", requirePermission("github.manage"), (c) => {
    if (GITHUB_KEYS.some((k) => d.settings.isManagedByConfig(k.key))) {
      throw conflict(
        "the GitHub App is managed by config (GANGWAY_GITHUB_*); the manifest flow cannot overwrite it",
      );
    }
    const state = d.states.issue();
    const manifest = buildManifest({
      baseDomain: d.baseDomain(),
      appOrigin: d.originFor("app"),
      hooksOrigin: d.originFor("hooks"),
    });
    return c.json({
      action: `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`,
      manifest,
      state,
    });
  });

  /** GitHub sent the browser back with `code` and `state`; the code becomes the credentials. */
  api.post("/github/manifest/exchange", requirePermission("github.manage"), async (c) => {
    const body = await c.req.json().catch(() => {
      throw badRequest("the request body is not JSON");
    });
    const { code, state } = ManifestExchangeSchema.parse(body);
    if (!d.states.consume(state))
      throw unprocessable("the manifest state is unknown or expired; start again");
    if (GITHUB_KEYS.some((k) => d.settings.isManagedByConfig(k.key))) {
      throw conflict(
        "the GitHub App is managed by config (GANGWAY_GITHUB_*); the manifest flow cannot overwrite it",
      );
    }
    const app = await d.app.convertManifest(code);
    d.settings.set(SETTINGS.githubAppId, app.appId);
    d.settings.set(SETTINGS.githubAppSlug, app.slug);
    d.settings.set(SETTINGS.githubClientId, app.clientId);
    d.settings.set(SETTINGS.githubClientSecret, app.clientSecret);
    d.settings.set(SETTINGS.githubPrivateKey, app.privateKey);
    d.settings.set(SETTINGS.githubWebhookSecret, app.webhookSecret);
    d.audit.record(c.get("actor"), "github.connected", app.appId, {
      new: {
        appId: app.appId,
        slug: app.slug,
        privateKey: "[set]",
        webhookSecret: "[set]",
        clientSecret: "[set]",
      },
    });
    return c.json(status(), 201);
  });
}
