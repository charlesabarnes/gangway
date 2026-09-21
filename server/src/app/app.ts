/**
 * The application router: everything behind a RESERVED label (§3.1). Hono is a leaf --
 * it never sees a preview request, because the dispatcher has already decided this one
 * is ours by the time it arrives here.
 *
 * One Hono app serves both the `app` and `api` surfaces. `/v1` answers on both, so the
 * Angular UI calls its own origin and there is no CORS anywhere; the static shell
 * answers on `app` only, so `api.<domain>/` is never a web page.
 */
import { Hono } from "hono";
import type { TokenVerifier } from "../auth/actor.ts";
import { AppError, notFound } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { Surface, SurfaceHandler } from "../net/dispatch.ts";
import { ulid } from "../util/ulid.ts";
import type { AppEnv } from "./env.ts";
import { authenticate } from "./middleware/auth.ts";
import { errorHandler, problemResponse } from "./problem.ts";
import { serveStatic } from "./static.ts";

export type AppDeps = {
  logger: Logger;
  verifyToken: TokenVerifier;
  /** The built Angular app. Absent until T33; the `app` surface then serves only /v1. */
  staticDir?: string | undefined;
  /** Mounted under /v1, behind authentication. */
  v1: (api: Hono<AppEnv>) => void;
  health?: () => Record<string, unknown>;
  /** True once shutdown has begun: the control plane answers 503 while previews keep serving. */
  draining?: () => boolean;
};

export function createApp(d: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(async (c, next) => {
    // Always ours, never the caller's: an inbound X-Request-Id is attacker-controlled
    // text that would otherwise land in our logs.
    const id = ulid();
    c.set("requestId", id);
    await next();
    c.res.headers.set("x-request-id", id);
  });

  app.onError(errorHandler(d.logger));

  // Unauthenticated by design: an orchestrator's healthcheck has no token.
  app.get("/healthz", (c) => d.draining?.()
    ? c.json({ ok: false, draining: true }, 503)
    : c.json({ ok: true, ...(d.health?.() ?? {}) }));

  // Work accepted now would be cut off seconds later. Say so, and say when to come back.
  app.use(async (c, next) => {
    if (!d.draining?.()) return next();
    return problemResponse(c, new AppError("unavailable", "gangway is shutting down"), { "retry-after": "5", connection: "close" });
  });

  const api = new Hono<AppEnv>();
  api.use(authenticate(d.verifyToken));
  d.v1(api);
  app.route("/v1", api);

  app.notFound(async (c) => {
    const path = new URL(c.req.url).pathname;
    const isApiPath = path === "/v1" || path.startsWith("/v1/");
    if (c.env.surface === "app" && d.staticDir && !isApiPath) {
      const res = await serveStatic(c.req.raw, { root: d.staticDir });
      if (res) return res;
    }
    return problemResponse(c, notFound(`no such resource: ${path}`));
  });

  return app;
}

/** Adapts the Hono app to the dispatcher's handler shape for one surface. */
export function surfaceHandler(app: Hono<AppEnv>, surface: Surface): SurfaceHandler {
  return (req, ctx) => app.fetch(req, { surface, clientIp: ctx.clientIp });
}
