/**
 * Authentication and authorization. A verifier resolves a credential to an Actor, handlers
 * read `c.get("actor")`, and `requirePermission` gates every route. A route asks for a
 * PERMISSION, never a role or a scope: which role holds it is the operator's data.
 */
import type { MiddlewareHandler } from "hono";
import { can, type Permission, type TokenVerifier } from "../../auth/actor.ts";
import { forbidden, unauthorized } from "../../errors.ts";
import type { AppEnv } from "../env.ts";
import { problemResponse } from "../problem.ts";

const BEARER = /^Bearer\s+(\S+)$/i;

export function authenticate(verify: TokenVerifier): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const presented = BEARER.exec(c.req.header("authorization") ?? "")?.[1];
    const actor = presented ? await verify(presented) : null;
    if (!actor) {
      // One response for "no credential" and "wrong credential": do not tell a scanner
      // which of the two it has.
      return problemResponse(c, unauthorized(), { "www-authenticate": 'Bearer realm="gangway"' });
    }
    c.set("actor", actor);
    return next();
  };
}

/** Marks the middleware so a test can prove no `/v1` route was registered without one. */
export const PERMISSION_GUARD = Symbol("gangway.permission");

export function requirePermission(permission: Permission): MiddlewareHandler<AppEnv> {
  const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (!can(c.get("actor"), permission)) return problemResponse(c, forbidden(`requires the "${permission}" permission`));
    return next();
  };
  return Object.assign(guard, { [PERMISSION_GUARD]: permission });
}
