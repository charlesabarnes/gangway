/**
 * Authentication. Phase 1 is a static bearer token; the SHAPE is what matters -- a
 * verifier resolves a credential to an Actor, handlers read `c.get("actor")`, and
 * `requireScope` gates mutations. Phase 2 swaps the verifier (token table, sessions)
 * without touching a single route.
 */
import type { MiddlewareHandler } from "hono";
import { hasScope, type Scope, type TokenVerifier } from "../../auth/actor.ts";
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

export function requireScope(scope: Scope): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!hasScope(c.get("actor"), scope)) return problemResponse(c, forbidden(`requires the "${scope}" scope`));
    return next();
  };
}
