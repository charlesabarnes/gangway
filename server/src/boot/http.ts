import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeHost } from "@gangway/shared/hostname";
import { publicOriginFor } from "@gangway/shared/url";
import type { Hono } from "hono";
import { createApp } from "../app/app.ts";
import type { AppEnv } from "../app/env.ts";
import { McpSurface } from "../app/mcp-surface.ts";
import type { AuthDeps } from "../app/middleware/auth.ts";
import { oauthRootRoutes } from "../app/routes/oauth.ts";
import { chainVerifiers, staticTokenVerifier, workflowActor } from "../auth/actor.ts";
import { LoginLimiter } from "../auth/limiter.ts";
import { GitHubOidc } from "../auth/oidc.ts";
import { Tools } from "../mcp/tools.ts";
import { Uploads } from "../mcp/uploads.ts";
import { PreviewGate, loadOrCreateGateKey } from "../net/gate.ts";
import type { IdempotentDeploys } from "../previews/idempotent.ts";
import { SETTINGS } from "../settings.ts";
import type { PreviewWiring } from "./context.ts";
import type { Core } from "./core.ts";
import type { ForgeWiring } from "./forge.ts";
import type { Identity } from "./identity.ts";
import { publicRoutes, v1Routes } from "./routes.ts";

export type HttpParts = PreviewWiring &
  Pick<ForgeWiring, "githubApp" | "pulls"> & {
    deploys: IdempotentDeploys;
    identity: Identity;
    adminToken: string;
    signal: AbortSignal;
  };

type HttpDeps = Core & HttpParts;

export type Http = { app: Hono<AppEnv>; gate: PreviewGate; mcp: McpSurface };

export function createHttp(core: Core, parts: HttpParts): Http {
  const d: HttpDeps = { ...core, ...parts };
  const gate = createGate(d);
  const auth = createAuth(d);
  const mcp = createMcp(d);
  const mcpOn = () => d.settings.get(SETTINGS.surfacesMcp);
  const staticDir = resolve(import.meta.dir, "../../../web/dist/browser");
  const app = createApp({
    logger: d.logger.child({ mod: "app" }),
    ...auth,
    staticDir: existsSync(staticDir) ? staticDir : undefined,
    health: () => ({ routes: d.ctx.table.size }),
    draining: () => d.signal.aborted,
    root: (root) => oauthRootRoutes(root, { oauth: d.identity.oauth, enabled: mcpOn }),
    v1: (api) => v1Routes(api, { ...d, mcp, mcpOn }),
    publicV1: (pub) => publicRoutes(pub, { ctx: d.ctx, auth, identity: d.identity, gate }),
  });
  return { app, gate, mcp };
}

function createGate({ repos, settings, previewPasswords, origin, logger }: HttpDeps): PreviewGate {
  return new PreviewGate({
    key: loadOrCreateGateKey(repos.settings),
    appOrigin: () => origin("app"),
    sharedPassword: () =>
      settings.get(SETTINGS.previewPasswordMode) === "shared"
        ? settings.get(SETTINGS.previewPasswordShared)
        : null,
    passwords: previewPasswords,
    limiter: new LoginLimiter({ emailFree: 10 }),
    loginDefault: () => settings.get(SETTINGS.previewPasswordLogin),
    onPasswordFailure: (entry, clientIp, reason) =>
      logger.warn("preview password refused", {
        previewId: entry.previewId,
        host: entry.hostname,
        clientIp,
        reason,
      }),
  });
}

function createAuth({ identity, adminToken, origin, ctx, logger }: HttpDeps): AuthDeps {
  const oidc = new GitHubOidc({
    audience: () => origin("api"),
    logger: logger.child({ mod: "oidc" }),
  });
  return {
    verifyToken: chainVerifiers(
      identity.tokens.verify,
      staticTokenVerifier(adminToken),
      async (presented) => {
        const claims = await oidc.verify(presented);
        return claims ? workflowActor(claims) : null;
      },
    ),
    resolveSession: (secret: string) => identity.sessions.resolve(secret)?.actor ?? null,
    // From the public scheme and port, not the listener's: behind a reverse proxy they differ.
    originFor: (host: string) => publicOriginFor(normalizeHost(host) ?? "", ctx.origin),
  };
}

function createMcp(d: HttpDeps): McpSurface {
  const { identity, settings, logger } = d;
  const mcpOrigin = () => d.origin("mcp");
  const uploads = new Uploads({
    dir: join(d.stateDir, "uploads"),
    url: (id) => `${mcpOrigin()}/uploads/${id}`,
  });
  return new McpSurface({
    tools: new Tools({
      ctx: d.ctx,
      deploys: d.deploys,
      uploads,
      logger: logger.child({ mod: "mcp" }),
    }),
    uploads,
    // OAuth access tokens are accepted only here; the /v1 chain does not know them.
    verifyToken: chainVerifiers(
      identity.tokens.verify,
      staticTokenVerifier(d.adminToken),
      identity.oauth.verify,
    ),
    logger: logger.child({ mod: "mcp" }),
    oauth: {
      available: () => settings.get(SETTINGS.surfacesUi),
      resource: mcpOrigin,
      resourceMetadata: () => identity.oauth.resourceMetadata(),
    },
  });
}
