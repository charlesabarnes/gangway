import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { can, type Actor, type Permission, type TokenVerifier } from "../../auth/actor.ts";
import { forbidden, unauthorized } from "../../errors.ts";
import type { AppEnv } from "../env.ts";
import { problemResponse } from "../problem.ts";

const BEARER = /^Bearer\s+(\S+)$/i;
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

// Sent as __Host-gw_session so a same-site preview running someone else's code cannot plant a Domain cookie over it.
const SESSION_COOKIE = "gw_session";

export type AuthDeps = {
  verifyToken: TokenVerifier;
  resolveSession?: ((secret: string) => Actor | null) | undefined;
  originFor?: ((host: string) => string) | undefined;
};

// A sibling preview is same-site, never same-origin. Bearer requests skip this: a page cannot send Authorization cross-origin without a preflight.
export function isSameOrigin(
  c: Context<AppEnv>,
  originFor: NonNullable<AuthDeps["originFor"]>,
): boolean {
  const site = c.req.header("sec-fetch-site");
  if (site !== undefined && site !== "same-origin") return false;
  const origin = c.req.header("origin");
  return origin !== undefined && origin === originFor(c.req.header("host") ?? "");
}

export async function resolveActor(c: Context<AppEnv>, d: AuthDeps): Promise<Actor | null> {
  const header = c.req.header("authorization");
  if (header !== undefined) {
    // A presented-but-wrong bearer never falls back to the cookie.
    const presented = BEARER.exec(header)?.[1];
    return presented ? await d.verifyToken(presented) : null;
  }
  if (!d.resolveSession || c.env.surface !== "app") return null;
  const secret = getCookie(c, SESSION_COOKIE, "host");
  if (!secret) return null;
  const actor = d.resolveSession(secret);
  if (!actor) return null;
  if (!SAFE.has(c.req.method) && !(d.originFor && isSameOrigin(c, d.originFor))) {
    throw forbidden("cross-origin request refused");
  }
  return actor;
}

export function authenticate(d: AuthDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = await resolveActor(c, d);
    if (!actor) {
      // Missing and wrong credentials get the same 401; a workflow token is only valid on its one route.
      return problemResponse(c, unauthorized(), { "www-authenticate": 'Bearer realm="gangway"' });
    }
    if (actor.kind === "workflow" && !WORKFLOW_PATH.test(c.req.path)) {
      return problemResponse(
        c,
        forbidden("a workflow token may only deploy and tear down its own project's pull requests"),
      );
    }
    c.set("actor", actor);
    return next();
  };
}

const WORKFLOW_PATH = /^\/v1\/projects\/[^/]+\/pulls\/\d+$/;

export const PERMISSION_GUARD = Symbol("gangway.permission");

export function requirePermission(
  permission: Permission,
  ...alternatives: Permission[]
): MiddlewareHandler<AppEnv> {
  const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
    const actor = c.get("actor");
    if (![permission, ...alternatives].some((p) => can(actor, p)))
      return problemResponse(c, forbidden(`requires the "${permission}" permission`));
    return next();
  };
  return Object.assign(guard, { [PERMISSION_GUARD]: permission });
}

export function setSessionCookie(c: Context<AppEnv>, secret: string, maxAgeSec: number): void {
  setCookie(c, SESSION_COOKIE, secret, {
    prefix: "host",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: maxAgeSec,
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { prefix: "host", path: "/", secure: true });
}
