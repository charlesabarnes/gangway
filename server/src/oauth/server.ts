import { randomBytes } from "node:crypto";
import type { OAuthGrant } from "@gangway/shared/domain";
import { SCOPE_PERMISSIONS, type Permission } from "@gangway/shared/permissions";
import type { AuditSink } from "../audit/audit.ts";
import { can, permissionsForScopes, type Actor, type TokenVerifier } from "../auth/actor.ts";
import type { RolePermissions } from "../auth/roles.ts";
import type { OAuthGrantsRepo } from "../db/repos/oauth-grants.ts";
import { forbidden, notFound, unprocessable } from "../errors.ts";
import { checkAuthorizeRequest, singleParams } from "./authorize-request.ts";
import { OAUTH_SCOPES, offeredScopes, type OAuthScope } from "./scopes.ts";
import {
  ClientMetadataError,
  redirectAllowed,
  type ClientMetadataStore,
} from "./client-metadata.ts";
import {
  sameResource,
  TokenEndpoint,
  type OAuthErrorCode,
  type TokenResponse,
} from "./token-endpoint.ts";
import { sha256 } from "../util/hash.ts";

export {
  ACCESS_TTL_MS,
  OAuthError,
  REFRESH_IDLE_MS,
  REFRESH_REUSE_GRACE_MS,
} from "./token-endpoint.ts";

const PENDING_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;
const MAX_PENDING = 1_000;
const TOUCH_EVERY_MS = 60_000;

const ACCESS_SHAPE = /^gwa_[A-Za-z0-9_-]{43}$/;

export type AuthorizeOutcome =
  | { kind: "page"; error: string }
  | { kind: "redirect"; url: string }
  | { kind: "consent"; requestId: string };

type Pending = {
  id: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string | null;
  challenge: string;
  scopes: OAuthScope[];
  resource: string;
  expiresAt: number;
};

export type ConsentView = {
  id: string;
  client: { id: string; name: string; host: string };
  redirectUri: string;
  redirectHost: string;
  resource: string;
  requested: OAuthScope[];
  offered: OAuthScope[];
  grantable: OAuthScope[];
  scopePermissions: Record<OAuthScope, readonly Permission[]>;
  expiresAt: Date;
};

export type OAuthServerDeps = {
  grants: OAuthGrantsRepo;
  clients: Pick<ClientMetadataStore, "get">;
  roles: RolePermissions;
  audit: AuditSink;
  issuer: () => string;
  resource: () => string;
  now?: () => number;
};

export class OAuthServer {
  readonly #d: OAuthServerDeps;
  readonly #now: () => number;
  readonly #pending = new Map<string, Pending>();
  readonly #tokens: TokenEndpoint;

  constructor(d: OAuthServerDeps) {
    this.#d = d;
    this.#now = d.now ?? Date.now;
    this.#tokens = new TokenEndpoint({ grants: d.grants, audit: d.audit, now: this.#now });
  }

  metadata() {
    const iss = this.#d.issuer();
    return {
      issuer: iss,
      authorization_endpoint: `${iss}/oauth/authorize`,
      token_endpoint: `${iss}/oauth/token`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [...OAUTH_SCOPES],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  }

  resourceMetadata() {
    return {
      resource: this.#d.resource(),
      authorization_servers: [this.#d.issuer()],
      scopes_supported: [...OAUTH_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "gangway",
    };
  }

  #sweep(): void {
    const now = this.#now();
    for (const [k, p] of this.#pending) if (p.expiresAt <= now) this.#pending.delete(k);
    this.#tokens.sweep(now);
  }

  #redirect(base: string, params: Record<string, string | null>): string {
    const u = new URL(base);
    for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
    u.searchParams.set("iss", this.#d.issuer());
    return u.href;
  }

  async authorize(q: URLSearchParams): Promise<AuthorizeOutcome> {
    this.#sweep();
    const one = singleParams(q);
    const clientId = one("client_id");
    const redirectUri = one("redirect_uri");
    if (!clientId) return { kind: "page", error: "The request names no client (client_id)." };
    if (!redirectUri) return { kind: "page", error: "The request names no redirect_uri." };

    let client;
    try {
      client = await this.#d.clients.get(clientId);
    } catch (err) {
      return {
        kind: "page",
        error: `The client could not be identified: ${err instanceof ClientMetadataError ? err.message : "its metadata could not be read"}.`,
      };
    }
    if (!redirectAllowed(redirectUri, client.redirectUris))
      return { kind: "page", error: `${client.clientName} did not register that redirect_uri.` };

    const state = one("state") ?? null;
    const fail = (error: OAuthErrorCode, description: string): AuthorizeOutcome => ({
      kind: "redirect",
      url: this.#redirect(redirectUri, { error, error_description: description, state }),
    });

    const request = checkAuthorizeRequest(one, this.#d.resource());
    if ("error" in request) return fail(request.error, request.description);

    if (this.#pending.size >= MAX_PENDING)
      return fail("server_error", "too many authorizations in progress; try again shortly");
    const id = randomBytes(24).toString("base64url");
    this.#pending.set(id, {
      id,
      clientId,
      clientName: client.clientName,
      redirectUri,
      state,
      challenge: request.challenge,
      scopes: request.scopes,
      resource: this.#d.resource(),
      expiresAt: this.#now() + PENDING_TTL_MS,
    });
    return { kind: "consent", requestId: id };
  }

  #person(actor: Actor): Extract<Actor, { kind: "user" }> {
    if (actor.kind !== "user") throw forbidden("only a person, logged in, can connect an agent");
    return actor;
  }

  #grantable(actor: Actor, requested: readonly OAuthScope[]): OAuthScope[] {
    return offeredScopes(requested).filter((s) => SCOPE_PERMISSIONS[s].every((p) => can(actor, p)));
  }

  #pendingFor(id: string): Pending {
    this.#sweep();
    const p = this.#pending.get(id);
    if (!p)
      throw notFound(
        "this authorization request has expired or was already answered; start again from the app that sent you",
      );
    return p;
  }

  view(actor: Actor, id: string): ConsentView {
    this.#person(actor);
    const p = this.#pendingFor(id);
    return {
      id,
      client: { id: p.clientId, name: p.clientName, host: new URL(p.clientId).host },
      redirectUri: p.redirectUri,
      redirectHost: new URL(p.redirectUri).host,
      resource: p.resource,
      requested: p.scopes,
      offered: offeredScopes(p.scopes),
      grantable: this.#grantable(actor, p.scopes),
      scopePermissions: {
        read: SCOPE_PERMISSIONS.read,
        deploy: SCOPE_PERMISSIONS.deploy,
        update: SCOPE_PERMISSIONS.update,
        artifacts: SCOPE_PERMISSIONS.artifacts,
      },
      expiresAt: new Date(p.expiresAt),
    };
  }

  decide(
    actor: Actor,
    id: string,
    answer: { approve: boolean; scopes?: readonly string[] | undefined },
  ): { redirect: string } {
    const user = this.#person(actor);
    const p = this.#pendingFor(id);
    if (!answer.approve) {
      this.#pending.delete(id);
      return {
        redirect: this.#redirect(p.redirectUri, {
          error: "access_denied",
          error_description: "the user declined",
          state: p.state,
        }),
      };
    }
    const chosen = [...new Set(answer.scopes ?? p.scopes)];
    const grantable = this.#grantable(actor, p.scopes);
    const refused = chosen.filter((s) => !(grantable as string[]).includes(s));
    if (chosen.length === 0) throw unprocessable("choose at least one scope, or deny");
    if (refused.length > 0)
      throw unprocessable(
        `cannot grant ${refused.join(", ")}: not offered, or your role does not cover it`,
        { refused },
      );
    this.#pending.delete(id);

    const code = randomBytes(32).toString("base64url");
    this.#tokens.remember(code, {
      clientId: p.clientId,
      redirectUri: p.redirectUri,
      challenge: p.challenge,
      scopes: chosen as OAuthScope[],
      resource: p.resource,
      userId: user.userId,
      clientName: p.clientName,
      expiresAt: this.#now() + CODE_TTL_MS,
      used: false,
      actor,
    });
    return { redirect: this.#redirect(p.redirectUri, { code, state: p.state }) };
  }

  token(form: URLSearchParams): TokenResponse {
    this.#sweep();
    return this.#tokens.token(form);
  }

  readonly verify: TokenVerifier = (presented) => {
    if (!ACCESS_SHAPE.test(presented)) return null;
    const now = this.#now();
    const rec = this.#d.grants.findByAccess(sha256(presented, "hex"), now);
    if (!rec || !sameResource(rec.resource, this.#d.resource())) return null;
    this.#d.grants.touch(rec.grant.id, now - TOUCH_EVERY_MS, now);
    const role = this.#d.roles.for(rec.owner.roleId);
    const permissions = new Set<Permission>(
      [...permissionsForScopes(rec.grant.scopes)].filter((p) => role.has(p)),
    );
    return {
      kind: "token",
      tokenId: `${OAUTH_TOKEN_PREFIX}${rec.grant.id}`,
      scopes: rec.grant.scopes,
      permissions,
      userId: rec.owner.id,
    };
  };

  list(actor: Actor, o: { all?: boolean } = {}): OAuthGrant[] {
    if (o.all) {
      if (!can(actor, "tokens.manage_all"))
        throw forbidden('requires the "tokens.manage_all" permission');
      return this.#d.grants.listAll();
    }
    return actor.kind === "user" ? this.#d.grants.listForUser(actor.userId) : [];
  }

  revoke(actor: Actor, id: string): OAuthGrant {
    const g = this.#d.grants.get(id);
    const mine = g !== undefined && actor.kind === "user" && g.userId === actor.userId;
    if (!g || !(mine || can(actor, "tokens.manage_all")))
      throw notFound(`no such connection: ${id}`);
    if (this.#d.grants.revoke(id))
      this.#d.audit.record(actor, "oauth.grant.revoked", id, {
        old: { client: g.clientId, scopes: g.scopes, userId: g.userId },
      });
    return this.#d.grants.get(id)!;
  }

  revokeAllFor(userId: string): void {
    this.#d.grants.revokeAllFor(userId);
  }
}

const OAUTH_TOKEN_PREFIX = "oauth:";
export const isOAuthActor = (a: Actor): a is Extract<Actor, { kind: "token" }> =>
  a.kind === "token" && a.tokenId.startsWith(OAUTH_TOKEN_PREFIX);
