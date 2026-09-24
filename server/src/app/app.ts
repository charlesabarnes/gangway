import { Hono } from "hono";
import { AppError, notFound } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { Surface, SurfaceHandler } from "../net/dispatch.ts";
import { ulid } from "../util/ulid.ts";
import type { AppEnv } from "./env.ts";
import { authenticate, type AuthDeps } from "./middleware/auth.ts";
import { errorHandler, problemResponse } from "./problem.ts";
import { serveStatic } from "./static.ts";
import { serveKitFont } from "./kit-fonts.ts";

export type AppDeps = AuthDeps & {
  logger: Logger;
  staticDir?: string | undefined;
  v1: (api: Hono<AppEnv>) => void;
  publicV1?: ((pub: Hono<AppEnv>) => void) | undefined;
  root?: ((app: Hono<AppEnv>) => void) | undefined;
  health?: () => Record<string, unknown>;
  draining?: () => boolean;
};

export function createApp(d: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(async (c, next) => {
    // Never reuse an inbound X-Request-Id: it is attacker-controlled text bound for the logs.
    const id = ulid();
    c.set("requestId", id);
    await next();
    c.res.headers.set("x-request-id", id);
  });

  app.onError(errorHandler(d.logger));

  app.use(async (c, next) => {
    await next();
    if (new URL(c.req.url).pathname === "/v1/auth/gate") return;
    try {
      c.res.headers.set("x-frame-options", "DENY");
      c.res.headers.append("content-security-policy", "frame-ancestors 'none'");
    } catch {
      // Immutable headers mean a proxied fetch, which nobody frames.
    }
  });

  app.get("/healthz", (c) =>
    d.draining?.()
      ? c.json({ ok: false, draining: true }, 503)
      : c.json({ ok: true, ...(d.health?.() ?? {}) }),
  );

  app.use(async (c, next) => {
    if (!d.draining?.()) return next();
    return problemResponse(c, new AppError("unavailable", "gangway is shutting down"), {
      "retry-after": "5",
      connection: "close",
    });
  });

  d.root?.(app);

  if (d.publicV1) {
    const pub = new Hono<AppEnv>();
    d.publicV1(pub);
    app.route("/v1", pub);
  }

  const api = new Hono<AppEnv>();
  api.use(authenticate(d));
  d.v1(api);
  app.route("/v1", api);

  app.notFound(async (c) => {
    const path = new URL(c.req.url).pathname;
    const isApiPath = path === "/v1" || path.startsWith("/v1/");
    if (c.env.surface === "app" && !isApiPath) {
      const font = await serveKitFont(c.req.raw);
      if (font) return font;
    }
    if (c.env.surface === "app" && d.staticDir && !isApiPath) {
      const res = await serveStatic(c.req.raw, { root: d.staticDir });
      if (res) return res;
    }
    return problemResponse(c, notFound(`no such resource: ${path}`));
  });

  return app;
}

export function surfaceHandler(app: Hono<AppEnv>, surface: Surface): SurfaceHandler {
  return (req, ctx) => app.fetch(req, { surface, clientIp: ctx.clientIp });
}
