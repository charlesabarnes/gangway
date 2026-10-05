import { timingSafeEqual } from "node:crypto";
import type { ForgeId } from "@gangway/shared/domain";
import {
  INSTANCE_PERMISSIONS,
  SCOPE_PERMISSIONS,
  targetPermissions,
  type Permission,
  type Scope,
  type SecretTargets,
} from "@gangway/shared/permissions";
import { sha256 } from "../util/hash.ts";

export type { Permission, Scope };

/** Every actor acts within one org, taken from its credential and never from the request. */
export type Actor = { orgId: string } & (
  | {
      kind: "token";
      tokenId: string;
      scopes: readonly Scope[];
      permissions: ReadonlySet<Permission>;
      userId?: string;
      /** The agent's client name or the API token's name, for the audit log. */
      name?: string;
      /** With the secrets scope: where this credential may set them. Absent: not narrowed. */
      secretTargets?: SecretTargets;
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
      /** The run's git ref, refs/heads/<branch> for a push. */
      ref: string;
      pull: number | null;
      permissions: ReadonlySet<Permission>;
    }
);

export function permissionsForScopes(scopes: readonly Scope[]): ReadonlySet<Permission> {
  return new Set(scopes.flatMap((s) => SCOPE_PERMISSIONS[s]));
}

/** A stored credential's permissions before its person's role narrows them. */
export function credentialPermissions(
  scopes: readonly Scope[],
  targets: SecretTargets | null | undefined,
): Set<Permission> {
  return new Set([...permissionsForScopes(scopes), ...targetPermissions(scopes, targets)]);
}

export const tokenActor = (tokenId: string, scopes: readonly Scope[], orgId: string): Actor => ({
  kind: "token",
  tokenId,
  scopes,
  permissions: permissionsForScopes(scopes),
  orgId,
});

export const systemActor = (job: string, orgId: string): Actor =>
  tokenActor(`system:${job}`, ["admin"], orgId);

const FORGE_PERMISSIONS: readonly Permission[] = [
  "previews.deploy",
  "previews.destroy",
  "previews.read",
  "logs.read",
];

export const forgeActor = (forge: ForgeId, login: string, orgId: string): Actor => ({
  kind: "forge",
  forge,
  login,
  permissions: new Set(FORGE_PERMISSIONS),
  orgId,
});

const WORKFLOW_PERMISSIONS: readonly Permission[] = [
  "previews.deploy",
  "previews.destroy",
  "previews.read",
];

export function workflowActor(
  c: {
    repository: string;
    runId: string;
    actor: string;
    eventName: string;
    ref: string;
  },
  orgId: string,
): Actor {
  const m = /^refs\/pull\/(\d+)\/(?:merge|head)$/.exec(c.ref);
  return {
    kind: "workflow",
    repository: c.repository,
    runId: c.runId,
    login: c.actor,
    eventName: c.eventName,
    ref: c.ref,
    pull: m ? Number(m[1]) : null,
    permissions: new Set(WORKFLOW_PERMISSIONS),
    orgId,
  };
}

export const can = (actor: Actor, needed: Permission): boolean => actor.permissions.has(needed);

export function actorId(a: Actor): string {
  switch (a.kind) {
    case "user":
      return `user:${a.userId}`;
    case "forge":
      return `${a.forge}:${a.login}`;
    case "workflow":
      return `actions:${a.repository}#${a.runId}`;
    case "token":
      return a.tokenId;
  }
}

export function principalOf(a: Actor): string | null {
  if (a.kind === "user") {
    return `user:${a.userId}`;
  }
  if (a.kind !== "token") {
    return null;
  }
  if (a.userId !== undefined) {
    return `user:${a.userId}`;
  }
  return a.tokenId.startsWith("system:") ? null : a.tokenId;
}

/** The API token or OAuth grant behind an actor, recorded on what it deploys. */
export function credentialOf(a: Actor): string | null {
  if (a.kind !== "token" || a.tokenId.startsWith("system:")) {
    return null;
  }
  return a.tokenId;
}

/** Who deployed a preview: the person, and the credential they used. */
export type Provenance = { owner: string | null; credential: string | null };

// A credential that may not read everything is held to what it deployed itself, not all its person did.
const confined = (a: Actor): boolean => a.kind === "token" && !can(a, "previews.read");

export function owns(a: Actor, p: Provenance): boolean {
  if (confined(a)) {
    return p.credential !== null && p.credential === credentialOf(a);
  }
  return p.owner !== null && p.owner === principalOf(a);
}

/** maySee as a list filter: {} for everything, the one owner or credential, or null for nothing. */
export function seeFilter(a: Actor): { owner?: string; credential?: string } | null {
  if (can(a, "previews.read")) {
    return {};
  }
  if (!can(a, "previews.read_own")) {
    return null;
  }
  if (confined(a)) {
    const credential = credentialOf(a);
    return credential === null ? null : { credential };
  }
  const owner = principalOf(a);
  return owner === null ? null : { owner };
}

export const maySee = (a: Actor, p: Provenance): boolean =>
  can(a, "previews.read") || (can(a, "previews.read_own") && owns(a, p));

export const mayReadLogs = (a: Actor, p: Provenance): boolean =>
  can(a, "logs.read") || (can(a, "previews.read_own") && owns(a, p));

export const mayDestroy = (a: Actor, p: Provenance): boolean =>
  can(a, "previews.destroy") || (can(a, "previews.destroy_own") && owns(a, p));

export function mayRebuild(a: Actor, p: Provenance): boolean {
  if (can(a, "previews.update")) {
    return true;
  }
  return can(a, "previews.update_own") && owns(a, p);
}

/** Deploying anything at all; what the source turns out to need is checked once it is planned. */
export const mayDeploy = (a: Actor): boolean =>
  can(a, "previews.deploy") || can(a, "previews.deploy_static");

export const mayRunContainers = (a: Actor): boolean => can(a, "previews.deploy");

export function auditActor(a: Actor): {
  type: "user" | "token" | "system" | "github";
  id: string;
  name?: string;
} {
  if (a.kind === "user") {
    return { type: "user", id: a.userId };
  }
  if (a.kind === "forge") {
    return { type: a.forge, id: a.login };
  }
  if (a.kind === "workflow") {
    return { type: "github", id: `actions:${a.repository}#${a.runId}` };
  }
  return a.tokenId.startsWith("system:")
    ? { type: "system", id: a.tokenId.slice("system:".length) }
    : { type: "token", id: a.tokenId, ...(a.name === undefined ? {} : { name: a.name }) };
}

export type TokenVerifier = (presented: string) => Actor | null | Promise<Actor | null>;

export function chainVerifiers(...verifiers: TokenVerifier[]): TokenVerifier {
  return async (presented) => {
    for (const verify of verifiers) {
      const actor = await verify(presented);
      if (actor) {
        return actor;
      }
    }
    return null;
  };
}

export const ENV_ADMIN_TOKEN_ID = "env:admin";

// Digests are compared because timingSafeEqual throws on a length mismatch, which would leak the length.
export function staticTokenVerifier(adminToken: string, homeOrgId: string): TokenVerifier {
  const expected = sha256(adminToken);
  const actor = tokenActor(ENV_ADMIN_TOKEN_ID, ["admin"], homeOrgId);
  return (presented) => (timingSafeEqual(sha256(presented), expected) ? actor : null);
}

/** An actor outside the home org, without what acts on the whole server. */
export function confinedToOrg(a: Actor, homeOrgId: string): Actor {
  if (a.orgId === homeOrgId) {
    return a;
  }
  return {
    ...a,
    permissions: new Set([...a.permissions].filter((p) => !INSTANCE_PERMISSIONS.has(p))),
  };
}

export const orgBound =
  (verify: TokenVerifier, homeOrgId: string): TokenVerifier =>
  async (presented) => {
    const a = await verify(presented);
    return a && confinedToOrg(a, homeOrgId);
  };
