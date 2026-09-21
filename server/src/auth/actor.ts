/**
 * Who is making a request. Lives BELOW app/ because the service layer takes an actor for
 * audit (§10.5.2) and must not import HTTP types to get one (ADR-0003).
 *
 * Two kinds: a `token` (bearer credential -- the env admin token, a database token, or
 * gangway acting for itself) and a `user` (session cookie). Phase 6 adds `app`. The union
 * grows; call sites ask `can(actor, permission)` and do not change.
 *
 * `permissions` is RESOLVED when the actor is built, per request: a role edit, a demotion
 * or a disabled account takes effect on the next request, not the next login.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { SCOPE_PERMISSIONS, type Permission, type Scope } from "../../../shared/src/permissions.ts";

export type { Permission, Scope };

export type Actor =
  | {
      kind: "token";
      tokenId: string;
      /** What the token was minted with (§8.2). For display; `permissions` is what is enforced. */
      scopes: readonly Scope[];
      permissions: ReadonlySet<Permission>;
      /** The owning account, for a database token. Absent on the env token and system actors. */
      userId?: string;
    }
  | { kind: "user"; userId: string; roleId: string; permissions: ReadonlySet<Permission>; sessionId: string };

export function permissionsForScopes(scopes: readonly Scope[]): ReadonlySet<Permission> {
  return new Set(scopes.flatMap((s) => SCOPE_PERMISSIONS[s]));
}

/** An ownerless token actor whose permissions are exactly its scopes' bundles. */
export const tokenActor = (tokenId: string, scopes: readonly Scope[]): Actor =>
  ({ kind: "token", tokenId, scopes, permissions: permissionsForScopes(scopes) });

/**
 * Work gangway does on its own behalf (the TTL sweep, later idle-sleep). Still a `token`
 * actor so audit lines have one shape; the `system:` prefix cannot collide with a real
 * token id and no verifier ever returns one.
 */
export const systemActor = (job: string): Actor => tokenActor(`system:${job}`, ["admin"]);

export const can = (actor: Actor, needed: Permission): boolean => actor.permissions.has(needed);

/**
 * One stable string per principal: the idempotency-key owner, the `by` on events, log
 * lines. A user's id is prefixed so it can never equal a token id.
 */
export const actorId = (a: Actor): string => (a.kind === "user" ? `user:${a.userId}` : a.tokenId);

/** The `audit.actor_type` / `actor_id` pair. */
export function auditActor(a: Actor): { type: "user" | "token" | "system"; id: string } {
  if (a.kind === "user") return { type: "user", id: a.userId };
  return a.tokenId.startsWith("system:") ? { type: "system", id: a.tokenId.slice("system:".length) } : { type: "token", id: a.tokenId };
}

/** Resolves a presented bearer credential to an actor, or null. Never throws. */
export type TokenVerifier = (presented: string) => Actor | null | Promise<Actor | null>;

/** The first verifier to recognise the credential answers; none does, and it is nobody's. */
export function chainVerifiers(...verifiers: TokenVerifier[]): TokenVerifier {
  return async (presented) => {
    for (const verify of verifiers) {
      const actor = await verify(presented);
      if (actor) return actor;
    }
    return null;
  };
}

/** The env admin token's id. It is the one token that may mint others: it is the operator. */
export const ENV_ADMIN_TOKEN_ID = "env:admin";

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/**
 * The headless-bootstrap verifier (§8.1): one static token from `GANGWAY_ADMIN_TOKEN`.
 * Compared as digests so the comparison is constant-time AND length-independent --
 * timingSafeEqual throws on a length mismatch, which would itself leak the length.
 */
export function staticTokenVerifier(adminToken: string): TokenVerifier {
  const expected = sha256(adminToken);
  const actor = tokenActor(ENV_ADMIN_TOKEN_ID, ["admin"]);
  return (presented) => (timingSafeEqual(sha256(presented), expected) ? actor : null);
}
