/**
 * Who is making a request. Lives BELOW app/ because the service layer takes an actor for
 * audit (§10.5.2) and must not import HTTP types to get one (ADR-0003).
 *
 * Phase 1 has exactly one actor: the static admin token. Phase 2 adds `user` (session
 * cookie) and database-backed tokens; Phase 6 adds `app`. The union grows, the call
 * sites do not change.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** §8.2. `admin` implies the other two; `deploy` implies `read`. */
export type Scope = "read" | "deploy" | "admin";

export type Actor = {
  kind: "token";
  tokenId: string;
  scopes: readonly Scope[];
};

const IMPLIES: Record<Scope, readonly Scope[]> = {
  admin: ["admin", "deploy", "read"],
  deploy: ["deploy", "read"],
  read: ["read"],
};

export function hasScope(actor: Actor, needed: Scope): boolean {
  return actor.scopes.some((s) => IMPLIES[s].includes(needed));
}

/** Resolves a presented bearer credential to an actor, or null. Never throws. */
export type TokenVerifier = (presented: string) => Actor | null | Promise<Actor | null>;

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/**
 * The Phase 1 verifier: one static token from `GANGWAY_ADMIN_TOKEN`. Compared as digests
 * so the comparison is constant-time AND length-independent -- timingSafeEqual throws on
 * a length mismatch, which would itself leak the length.
 */
export function staticTokenVerifier(adminToken: string): TokenVerifier {
  const expected = sha256(adminToken);
  const actor: Actor = { kind: "token", tokenId: "env:admin", scopes: ["admin"] };
  return (presented) => (timingSafeEqual(sha256(presented), expected) ? actor : null);
}
