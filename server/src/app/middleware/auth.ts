/**
 * Authentication and authorization. A credential resolves to an Actor, handlers read
 * `c.get("actor")`, and `requirePermission` gates every route. A route asks for a
 * PERMISSION, never a role or a scope: which role holds it is the operator's data.
 *
 * Two credentials (§8): a bearer token, anywhere; and the session cookie, on the `app`
 * surface only. When both are present the bearer wins -- it is the explicit one.
 *
 * ## Why the cookie needs more than SameSite
 *
 * Every preview lives at `<name>.preview.example.com`, which is the SAME SITE as
 * `app.preview.example.com`. `SameSite=Lax` stops other sites; it does nothing about a
 * preview, which is by definition somebody else's code. Two defences follow:
 *  - the `__Host-` prefix: the browser refuses the cookie unless it is Secure, host-only
 *    and Path=/, so a preview cannot plant a `Domain=.preview.example.com` cookie over ours;
 *  - an Origin check on every cookie-authenticated request that is not a read. A preview
 *    page CAN make the browser send our cookie (a plain form POST needs no preflight), but
 *    it cannot forge `Origin`. No token, nothing for the UI to carry.
 * A bearer request is exempt: a page cannot make a browser attach an Authorization header
 * cross-origin without a preflight we never answer.
 */
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { can, type Actor, type Permission, type TokenVerifier } from "../../auth/actor.ts";
import { forbidden, unauthorized } from "../../errors.ts";
import type { AppEnv } from "../env.ts";
import { problemResponse } from "../problem.ts";

const BEARER = /^Bearer\s+(\S+)$/i;
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** Sent as `__Host-gw_session`. */
const SESSION_COOKIE = "gw_session";

export type AuthDeps = {
  verifyToken: TokenVerifier;
  /** Absent: bearer tokens only (the UI is off, or a test does not need it). */
  resolveSession?: ((secret: string) => Actor | null) | undefined;
  /** The public origin a browser on `host` would send as `Origin`. */
  originFor?: ((host: string) => string) | undefined;
};

/**
 * True when the request could only have come from our own pages. `Sec-Fetch-Site` is
 * checked when the browser sends it -- a sibling preview is `same-site`, never
 * `same-origin` -- and `Origin` must match exactly. A missing Origin is a no.
 */
export function isSameOrigin(
  c: Context<AppEnv>,
  originFor: NonNullable<AuthDeps["originFor"]>,
): boolean {
  const site = c.req.header("sec-fetch-site");
  if (site !== undefined && site !== "same-origin") return false;
  const origin = c.req.header("origin");
  return origin !== undefined && origin === originFor(c.req.header("host") ?? "");
}

/**
 * The actor for this request, or null. Throws 403 for a cookie that arrived cross-origin
 * on a mutation -- distinct from 401 on purpose: the credential was fine, the request was not.
 */
export async function resolveActor(c: Context<AppEnv>, d: AuthDeps): Promise<Actor | null> {
  const header = c.req.header("authorization");
  if (header !== undefined) {
    // A presented-but-wrong bearer never falls through to the cookie.
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
      // One response for "no credential" and "wrong credential": do not tell a scanner
      // which of the two it has.
      return problemResponse(c, unauthorized(), { "www-authenticate": 'Bearer realm="gangway"' });
    }
    // ADR-0014: a workflow run is a credential for ONE route. Anywhere else it is nobody --
    // a leaked token from a PR's CI must not list previews, read logs or deploy an image.
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

/** The only path a workflow actor reaches. The route itself checks the project is its repository's. */
export const WORKFLOW_PATH = /^\/v1\/projects\/[^/]+\/pulls\/\d+$/;

/** Marks the middleware so a test can prove no `/v1` route was registered without one. */
export const PERMISSION_GUARD = Symbol("gangway.permission");

/**
 * `alternatives`: a broader permission that also lets the actor in, where the narrow one is
 * checked again below with the row in hand -- `previews.update_own` or `previews.update`,
 * and the service decides whose preview it is (ADR-0021). The route is marked with the first.
 */
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

/**
 * `Max-Age` is the absolute cap; the server decides when a session is really over, so the
 * cookie never has to be re-sent as the expiry slides.
 */
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
