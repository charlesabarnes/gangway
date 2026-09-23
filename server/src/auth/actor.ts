import { timingSafeEqual } from "node:crypto";
import type { ForgeId } from "@gangway/shared/domain";
import { SCOPE_PERMISSIONS, type Permission, type Scope } from "@gangway/shared/permissions";
import { sha256 } from "../util/hash.ts";

export type { Permission, Scope };

export type Actor =
  | {
      kind: "token";
      tokenId: string;
      scopes: readonly Scope[];
      permissions: ReadonlySet<Permission>;
      userId?: string;
    }
  | {
      kind: "user";
      userId: string;
      roleId: string;
      permissions: ReadonlySet<Permission>;
      sessionId: string;
    }
  | { kind: "forge"; forge: ForgeId; login: string; permissions: ReadonlySet<Permission> }
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

export const tokenActor = (tokenId: string, scopes: readonly Scope[]): Actor => ({
  kind: "token",
  tokenId,
  scopes,
  permissions: permissionsForScopes(scopes),
});

export const systemActor = (job: string): Actor => tokenActor(`system:${job}`, ["admin"]);

const FORGE_PERMISSIONS: readonly Permission[] = [
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

const WORKFLOW_PERMISSIONS: readonly Permission[] = [
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

export const actorId = (a: Actor): string =>
  a.kind === "user"
    ? `user:${a.userId}`
    : a.kind === "forge"
      ? `${a.forge}:${a.login}`
      : a.kind === "workflow"
        ? `actions:${a.repository}#${a.runId}`
        : a.tokenId;

export function principalOf(a: Actor): string | null {
  if (a.kind === "user") return `user:${a.userId}`;
  if (a.kind !== "token") return null;
  if (a.userId !== undefined) return `user:${a.userId}`;
  return a.tokenId.startsWith("system:") ? null : a.tokenId;
}

export function mayRebuild(a: Actor, owner: string | null): boolean {
  if (can(a, "previews.update")) return true;
  return can(a, "previews.update_own") && owner !== null && owner === principalOf(a);
}

export function auditActor(a: Actor): { type: "user" | "token" | "system" | "github"; id: string } {
  if (a.kind === "user") return { type: "user", id: a.userId };
  if (a.kind === "forge") return { type: a.forge, id: a.login };
  if (a.kind === "workflow") return { type: "github", id: `actions:${a.repository}#${a.runId}` };
  return a.tokenId.startsWith("system:")
    ? { type: "system", id: a.tokenId.slice("system:".length) }
    : { type: "token", id: a.tokenId };
}

export type TokenVerifier = (presented: string) => Actor | null | Promise<Actor | null>;

export function chainVerifiers(...verifiers: TokenVerifier[]): TokenVerifier {
  return async (presented) => {
    for (const verify of verifiers) {
      const actor = await verify(presented);
      if (actor) return actor;
    }
    return null;
  };
}

export const ENV_ADMIN_TOKEN_ID = "env:admin";

// Digests are compared because timingSafeEqual throws on a length mismatch, which would leak the length.
export function staticTokenVerifier(adminToken: string): TokenVerifier {
  const expected = sha256(adminToken);
  const actor = tokenActor(ENV_ADMIN_TOKEN_ID, ["admin"]);
  return (presented) => (timingSafeEqual(sha256(presented), expected) ? actor : null);
}
