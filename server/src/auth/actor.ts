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
import type { ForgeId } from "../../../shared/src/domain.ts";
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
  | {
      kind: "user";
      userId: string;
      roleId: string;
      permissions: ReadonlySet<Permission>;
      sessionId: string;
    }
  /**
   * A forge acting on a webhook (ADR-0011). `login` is whoever caused it -- the PR author,
   * the commenter -- for the audit line; the permissions are FIXED and not a role, so the
   * owner editing `member` never changes what a pull request may do.
   */
  | { kind: "forge"; forge: ForgeId; login: string; permissions: ReadonlySet<Permission> }
  /**
   * A GitHub Actions run, proved by its OIDC token (ADR-0014). Confined by the auth
   * middleware to `/v1/projects/:ref/pulls/:n`, and by that route to the project whose
   * repository is `repository`. `pull` is the PR number its `ref` names, if any.
   */
  | {
      kind: "workflow";
      repository: string;
      runId: string;
      login: string;
      eventName: string;
      pull: number | null;
      permissions: ReadonlySet<Permission>;
    };

export function permissionsForScopes(scopes: readonly Scope[]): ReadonlySet<Permission> {
  return new Set(scopes.flatMap((s) => SCOPE_PERMISSIONS[s]));
}

/** An ownerless token actor whose permissions are exactly its scopes' bundles. */
export const tokenActor = (tokenId: string, scopes: readonly Scope[]): Actor => ({
  kind: "token",
  tokenId,
  scopes,
  permissions: permissionsForScopes(scopes),
});

/**
 * Work gangway does on its own behalf (the TTL sweep, later idle-sleep). Still a `token`
 * actor so audit lines have one shape; the `system:` prefix cannot collide with a real
 * token id and no verifier ever returns one.
 */
export const systemActor = (job: string): Actor => tokenActor(`system:${job}`, ["admin"]);

export const FORGE_PERMISSIONS: readonly Permission[] = [
  "previews.deploy",
  "previews.destroy",
  "previews.read",
  "logs.read",
];

export const forgeActor = (forge: ForgeId, login: string): Actor => ({
  kind: "forge",
  forge,
  login,
  permissions: new Set(FORGE_PERMISSIONS),
});

/** Fixed, like a forge's: what a workflow may do inside the one route it can reach. */
export const WORKFLOW_PERMISSIONS: readonly Permission[] = [
  "previews.deploy",
  "previews.destroy",
  "previews.read",
];

export function workflowActor(c: {
  repository: string;
  runId: string;
  actor: string;
  eventName: string;
  ref: string;
}): Actor {
  const m = /^refs\/pull\/(\d+)\/(?:merge|head)$/.exec(c.ref);
  return {
    kind: "workflow",
    repository: c.repository,
    runId: c.runId,
    login: c.actor,
    eventName: c.eventName,
    pull: m ? Number(m[1]) : null,
    permissions: new Set(WORKFLOW_PERMISSIONS),
  };
}

export const can = (actor: Actor, needed: Permission): boolean => actor.permissions.has(needed);

/**
 * One stable string per principal: the idempotency-key owner, the `by` on events, log
 * lines. A user's id is prefixed so it can never equal a token id.
 */
export const actorId = (a: Actor): string =>
  a.kind === "user"
    ? `user:${a.userId}`
    : a.kind === "forge"
      ? `${a.forge}:${a.login}`
      : a.kind === "workflow"
        ? `actions:${a.repository}#${a.runId}`
        : a.tokenId;

/**
 * ADR-0021: who a preview belongs to. A person behind the credential -- a session, their
 * API token, their OAuth grant -- is `user:<id>`, so an agent that reconnects (a new grant)
 * still owns what it made. An ownerless token is itself; gangway's own jobs, a forge and a
 * workflow own nothing.
 */
export function principalOf(a: Actor): string | null {
  if (a.kind === "user") return `user:${a.userId}`;
  if (a.kind !== "token") return null;
  if (a.userId !== undefined) return `user:${a.userId}`;
  return a.tokenId.startsWith("system:") ? null : a.tokenId;
}

/** Rebuild in place (ADR-0015): any preview with `previews.update`, your own with `previews.update_own`. */
export function mayRebuild(a: Actor, owner: string | null): boolean {
  if (can(a, "previews.update")) return true;
  return can(a, "previews.update_own") && owner !== null && owner === principalOf(a);
}

/** The `audit.actor_type` / `actor_id` pair. */
export function auditActor(a: Actor): { type: "user" | "token" | "system" | "github"; id: string } {
  if (a.kind === "user") return { type: "user", id: a.userId };
  if (a.kind === "forge") return { type: a.forge, id: a.login };
  if (a.kind === "workflow") return { type: "github", id: `actions:${a.repository}#${a.runId}` };
  return a.tokenId.startsWith("system:")
    ? { type: "system", id: a.tokenId.slice("system:".length) }
    : { type: "token", id: a.tokenId };
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
