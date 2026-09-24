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

/** The API token or OAuth grant behind an actor, recorded on what it deploys. */
export function credentialOf(a: Actor): string | null {
  if (a.kind !== "token" || a.tokenId.startsWith("system:")) return null;
  return a.tokenId;
}

/** Who deployed a preview: the person, and the credential they used. */
export type Provenance = { owner: string | null; credential: string | null };

// A credential that may not read everything is held to what it deployed itself, not all its person did.
const confined = (a: Actor): boolean => a.kind === "token" && !can(a, "previews.read");

export function owns(a: Actor, p: Provenance): boolean {
  if (confined(a)) return p.credential !== null && p.credential === credentialOf(a);
  return p.owner !== null && p.owner === principalOf(a);
}

export const maySee = (a: Actor, p: Provenance): boolean =>
  can(a, "previews.read") || (can(a, "previews.read_own") && owns(a, p));

export const mayReadLogs = (a: Actor, p: Provenance): boolean =>
  can(a, "logs.read") || (can(a, "previews.read_own") && owns(a, p));

export const mayDestroy = (a: Actor, p: Provenance): boolean =>
  can(a, "previews.destroy") || (can(a, "previews.destroy_own") && owns(a, p));

export function mayRebuild(a: Actor, p: Provenance): boolean {
  if (can(a, "previews.update")) return true;
  return can(a, "previews.update_own") && owns(a, p);
}

/** Deploying anything at all; what the source turns out to need is checked once it is planned. */
export const mayDeploy = (a: Actor): boolean =>
  can(a, "previews.deploy") || can(a, "previews.deploy_static");

export const mayRunContainers = (a: Actor): boolean => can(a, "previews.deploy");

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
