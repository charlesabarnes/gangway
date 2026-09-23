/**
 * The OAuth 2.1 authorization server (ADR-0020), for MCP clients: claude.ai's custom
 * connectors and Claude Code. Authorization code + PKCE (S256 only), public clients named
 * by Client ID Metadata Documents, refresh tokens rotated on every use, and access tokens
 * that are good on ONE resource: the MCP surface.
 *
 * A grant is a credential of the user's own, like an API token (ADR-0010), and follows
 * its rules: its scopes are bundles, what it may do is those bundles INTERSECTED with the
 * owner's role on every request, and consenting is strict -- a scope is offered only if the
 * role covers its whole bundle. Only a logged-in person can consent; no token can.
 *
 * Nothing here knows HTTP. The routes (`app/routes/oauth.ts`) and the MCP surface adapt it.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { OAuthGrant } from "../../../shared/src/domain.ts";
import { SCOPE_PERMISSIONS, type Permission, type Scope } from "../../../shared/src/permissions.ts";
import type { AuditSink } from "../audit/audit.ts";
import { can, permissionsForScopes, type Actor, type TokenVerifier } from "../auth/actor.ts";
import type { RolePermissions } from "../auth/roles.ts";
import type { OAuthGrantsRepo } from "../db/repos/oauth-grants.ts";
import { forbidden, notFound, unprocessable } from "../errors.ts";
import { ulid } from "../util/ulid.ts";
import {
  ClientMetadataError,
  redirectAllowed,
  type ClientMetadataStore,
} from "./client-metadata.ts";

/** What OAuth may grant. Never `admin`: an agent holding the keys to the server is not a feature. */
export const OAUTH_SCOPES = ["read", "deploy", "update"] as const satisfies readonly Scope[];
export type OAuthScope = (typeof OAUTH_SCOPES)[number];
/**
 * A request that names no scope. Not `update` (ADR-0021): `deploy` already rebuilds your own.
 * All three ARE advertised, so a client that asks for every `scopes_supported` (Codex does)
 * gets `update` offered on its first consent, where the page pre-ticks what the role covers.
 * The owner chose that over holding it back for a step-up.
 */
export const DEFAULT_OAUTH_SCOPES: readonly OAuthScope[] = ["read", "deploy"];

export const ACCESS_TTL_MS = 3_600_000;
export const REFRESH_IDLE_MS = 30 * 86_400_000;
export const GRANT_ABSOLUTE_MS = 90 * 86_400_000;
/** A rotated-away refresh token back this soon is the client racing itself: refused, not revoked. */
export const REFRESH_REUSE_GRACE_MS = 60_000;
const PENDING_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;
const MAX_PENDING = 1_000;
const TOUCH_EVERY_MS = 60_000;

const ACCESS_SHAPE = /^gwa_[A-Za-z0-9_-]{43}$/;
const REFRESH_SHAPE = /^gwr_[A-Za-z0-9_-]{43}$/;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;
const pkce = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** RFC 6749 §5.2 / §4.1.2.1 error codes, plus RFC 8707's `invalid_target`. */
export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "access_denied"
  | "unsupported_response_type"
  | "invalid_target"
  | "server_error";

export class OAuthError extends Error {
  readonly code: OAuthErrorCode;
  readonly status: number;
  constructor(code: OAuthErrorCode, description: string, status = 400) {
    super(description);
    this.code = code;
    this.status = status;
  }
}

/** The outcome of `GET /oauth/authorize`. */
export type AuthorizeOutcome =
  /** The client or its redirect could not be trusted: say so, redirect nowhere. */
  | { kind: "page"; error: string }
  /** Anything later: back to the client with an error. */
  | { kind: "redirect"; url: string }
  /** Valid: ask the user. */
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
type Code = {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scopes: OAuthScope[];
  resource: string;
  userId: string;
  clientName: string;
  expiresAt: number;
  used: boolean;
  grantId?: string;
  /** Who consented: the audit row for the grant names them. */
  actor: Actor;
};

/** What the consent page shows. */
export type ConsentView = {
  id: string;
  client: { id: string; name: string; host: string };
  redirectUri: string;
  redirectHost: string;
  resource: string;
  requested: OAuthScope[];
  /** The requested scopes this user's role fully covers: the only ones they can grant. */
  grantable: OAuthScope[];
  scopePermissions: Record<OAuthScope, readonly Permission[]>;
  expiresAt: Date;
};

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

export type OAuthServerDeps = {
  grants: OAuthGrantsRepo;
  clients: Pick<ClientMetadataStore, "get">;
  roles: RolePermissions;
  audit: AuditSink;
  /** `https://app.<base>`: what `iss` and the metadata say. */
  issuer: () => string;
  /** `https://mcp.<base>`: the one resource a token is good for. */
  resource: () => string;
  now?: () => number;
};

const sameResource = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

export class OAuthServer {
  readonly #d: OAuthServerDeps;
  readonly #now: () => number;
  readonly #pending = new Map<string, Pending>();
  readonly #codes = new Map<string, Code>();

  constructor(d: OAuthServerDeps) {
    this.#d = d;
    this.#now = d.now ?? Date.now;
  }

  /** RFC 8414 metadata, served at `/.well-known/oauth-authorization-server` on the issuer. */
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

  /** RFC 9728 metadata, served on the MCP surface. */
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
    for (const [k, c] of this.#codes) if (c.expiresAt <= now) this.#codes.delete(k);
  }

  #redirect(base: string, params: Record<string, string | null>): string {
    const u = new URL(base);
    for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
    u.searchParams.set("iss", this.#d.issuer());
    return u.href;
  }

  /** `GET /oauth/authorize`. RFC 6749 §4.1.2.1: until the redirect is trusted, redirect nowhere. */
  async authorize(q: URLSearchParams): Promise<AuthorizeOutcome> {
    this.#sweep();
    const one = (k: string) => {
      const all = q.getAll(k);
      return all.length === 1 ? all[0]! : all.length === 0 ? null : undefined;
    };
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

    for (const k of [
      "response_type",
      "code_challenge",
      "code_challenge_method",
      "scope",
      "resource",
      "state",
    ]) {
      if (one(k) === undefined) return fail("invalid_request", `${k} was given more than once`);
    }
    if (one("response_type") !== "code")
      return fail("unsupported_response_type", "only response_type=code is supported");
    const challenge = one("code_challenge");
    if (!challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge))
      return fail("invalid_request", "PKCE is required: send code_challenge");
    if (one("code_challenge_method") !== "S256")
      return fail("invalid_request", "code_challenge_method must be S256");
    const resource = one("resource") ?? this.#d.resource();
    if (!sameResource(resource, this.#d.resource()))
      return fail("invalid_target", `tokens here are only for ${this.#d.resource()}`);

    const asked = (one("scope") ?? "").split(" ").filter((s) => s !== "" && s !== "offline_access");
    const unknown = asked.filter((s) => !(OAUTH_SCOPES as readonly string[]).includes(s));
    if (unknown.length > 0)
      return fail(
        "invalid_scope",
        `unknown scope: ${unknown.join(" ")}; gangway grants ${OAUTH_SCOPES.join(", ")}`,
      );
    const scopes = (
      asked.length === 0 ? [...DEFAULT_OAUTH_SCOPES] : [...new Set(asked)]
    ) as OAuthScope[];

    if (this.#pending.size >= MAX_PENDING)
      return fail("server_error", "too many authorizations in progress; try again shortly");
    const id = randomBytes(24).toString("base64url");
    this.#pending.set(id, {
      id,
      clientId,
      clientName: client.clientName,
      redirectUri,
      state,
      challenge,
      scopes,
      resource: this.#d.resource(),
      expiresAt: this.#now() + PENDING_TTL_MS,
    });
    return { kind: "consent", requestId: id };
  }

  #person(actor: Actor): Extract<Actor, { kind: "user" }> {
    // Consent is a person at a browser. A token -- even the env admin token -- cannot.
    if (actor.kind !== "user") throw forbidden("only a person, logged in, can connect an agent");
    return actor;
  }

  #grantable(actor: Actor, scopes: readonly OAuthScope[]): OAuthScope[] {
    return scopes.filter((s) => SCOPE_PERMISSIONS[s].every((p) => can(actor, p)));
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
      grantable: this.#grantable(actor, p.scopes),
      scopePermissions: {
        read: SCOPE_PERMISSIONS.read,
        deploy: SCOPE_PERMISSIONS.deploy,
        update: SCOPE_PERMISSIONS.update,
      },
      expiresAt: new Date(p.expiresAt),
    };
  }

  /** Approve or deny. Either way the request is spent, and the answer is where to send the browser. */
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
        `cannot grant ${refused.join(", ")}: not requested, or your role does not cover it`,
        { refused },
      );
    this.#pending.delete(id);

    const code = randomBytes(32).toString("base64url");
    this.#codes.set(code, {
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

  /** `POST /oauth/token`, form-encoded. Throws OAuthError; the route renders RFC 6749 §5.2. */
  token(form: URLSearchParams): TokenResponse {
    this.#sweep();
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") return this.#exchange(form);
    if (grantType === "refresh_token") return this.#refresh(form);
    throw new OAuthError(
      "unsupported_grant_type",
      "grant_type must be authorization_code or refresh_token",
    );
  }

  #issue(): { access: string; refresh: string; accessExpiresAt: number; refreshExpiresAt: number } {
    const now = this.#now();
    return {
      access: secret("gwa"),
      refresh: secret("gwr"),
      accessExpiresAt: now + ACCESS_TTL_MS,
      refreshExpiresAt: now + REFRESH_IDLE_MS,
    };
  }

  #exchange(form: URLSearchParams): TokenResponse {
    const raw = form.get("code") ?? "";
    const c = this.#codes.get(raw);
    if (!c || c.expiresAt <= this.#now())
      throw new OAuthError("invalid_grant", "the authorization code is unknown or expired");
    if (c.used) {
      // RFC 6749 §4.1.2: a code used twice means someone else has it. Kill what it made.
      if (c.grantId && this.#d.grants.revoke(c.grantId))
        this.#d.audit.record(null, "oauth.grant.revoked", c.grantId, {
          new: { reason: "authorization code replayed" },
        });
      throw new OAuthError("invalid_grant", "the authorization code was already used");
    }
    if (form.get("client_id") !== c.clientId)
      throw new OAuthError("invalid_grant", "the code was issued to another client");
    if (form.get("redirect_uri") !== c.redirectUri)
      throw new OAuthError(
        "invalid_grant",
        "redirect_uri does not match the authorization request",
      );
    const resource = form.get("resource");
    if (resource !== null && !sameResource(resource, c.resource))
      throw new OAuthError("invalid_target", `tokens here are only for ${c.resource}`);
    const verifier = form.get("code_verifier") ?? "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
      throw new OAuthError("invalid_grant", "code_verifier is missing or malformed");
    const expected = Buffer.from(c.challenge);
    const got = Buffer.from(pkce(verifier));
    if (expected.length !== got.length || !timingSafeEqual(expected, got))
      throw new OAuthError("invalid_grant", "code_verifier does not match the code_challenge");
    c.used = true;

    const now = this.#now();
    const t = this.#issue();
    const grant = this.#d.grants.create({
      id: ulid(now),
      userId: c.userId,
      clientId: c.clientId,
      clientName: c.clientName,
      redirectUri: c.redirectUri,
      scopes: c.scopes,
      resource: c.resource,
      accessHash: sha256(t.access),
      accessExpiresAt: t.accessExpiresAt,
      refreshHash: sha256(t.refresh),
      refreshExpiresAt: t.refreshExpiresAt,
      absoluteExpiresAt: now + GRANT_ABSOLUTE_MS,
    });
    c.grantId = grant.id;
    this.#d.audit.record(c.actor, "oauth.grant.created", grant.id, {
      new: {
        client: c.clientId,
        clientName: c.clientName,
        redirectUri: c.redirectUri,
        scopes: c.scopes,
      },
    });
    return {
      access_token: t.access,
      token_type: "Bearer",
      expires_in: Math.round(ACCESS_TTL_MS / 1000),
      refresh_token: t.refresh,
      scope: c.scopes.join(" "),
    };
  }

  #refresh(form: URLSearchParams): TokenResponse {
    const presented = form.get("refresh_token") ?? "";
    if (!REFRESH_SHAPE.test(presented))
      throw new OAuthError("invalid_grant", "the refresh token is not valid");
    const hash = sha256(presented);
    const rec = this.#d.grants.findByRefresh(hash);
    if (!rec) {
      const replayed = this.#d.grants.findByPreviousRefresh(hash);
      // Within the grace window it is two refreshes in flight with one token (or a retry after
      // a lost answer): the loser is refused and the winner's tokens stand.
      const racing =
        replayed?.rotatedAt != null && this.#now() - replayed.rotatedAt < REFRESH_REUSE_GRACE_MS;
      if (
        replayed &&
        !racing &&
        replayed.grant.revokedAt === null &&
        this.#d.grants.revoke(replayed.grant.id)
      ) {
        // OAuth 2.1 §4.3.1: a rotated-away refresh token came back. One of the two holders is
        // not the client; there is no telling which, so neither keeps the grant.
        this.#d.audit.record(null, "oauth.grant.revoked", replayed.grant.id, {
          new: { reason: "refresh token replayed", client: replayed.grant.clientId },
        });
      }
      throw new OAuthError("invalid_grant", "the refresh token is not valid");
    }
    const { grant } = rec;
    const now = this.#now();
    if (form.get("client_id") !== grant.clientId)
      throw new OAuthError("invalid_grant", "the refresh token was issued to another client");
    const resource = form.get("resource");
    if (resource !== null && !sameResource(resource, rec.resource))
      throw new OAuthError("invalid_target", `tokens here are only for ${rec.resource}`);
    if (rec.refreshExpiresAt <= now || grant.expiresAt.getTime() <= now)
      throw new OAuthError("invalid_grant", "the grant has expired; connect again");
    if (rec.owner.disabled)
      throw new OAuthError("invalid_grant", "the account behind this grant is disabled");
    // Asked for fewer scopes: allowed (RFC 6749 §6); more: never.
    const asked = (form.get("scope") ?? "")
      .split(" ")
      .filter((s) => s !== "" && s !== "offline_access");
    if (asked.some((s) => !(grant.scopes as string[]).includes(s)))
      throw new OAuthError("invalid_scope", "a refresh cannot widen the grant");

    const t = this.#issue();
    const refreshExpiresAt = Math.min(t.refreshExpiresAt, grant.expiresAt.getTime());
    if (
      !this.#d.grants.rotate(grant.id, hash, {
        accessHash: sha256(t.access),
        accessExpiresAt: Math.min(t.accessExpiresAt, refreshExpiresAt),
        refreshHash: sha256(t.refresh),
        refreshExpiresAt,
      })
    ) {
      throw new OAuthError("invalid_grant", "the refresh token is not valid");
    }
    return {
      access_token: t.access,
      token_type: "Bearer",
      expires_in: Math.round(ACCESS_TTL_MS / 1000),
      refresh_token: t.refresh,
      scope: grant.scopes.join(" "),
    };
  }

  /**
   * For the MCP surface's verifier chain, ONLY. An access token is good for one resource;
   * `/v1` never sees this verifier, so a token minted for MCP opens nothing else.
   */
  readonly verify: TokenVerifier = (presented) => {
    if (!ACCESS_SHAPE.test(presented)) return null;
    const now = this.#now();
    const rec = this.#d.grants.findByAccess(sha256(presented), now);
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

  /** Your own grants; with `all` and `tokens.manage_all`, everyone's. */
  list(actor: Actor, o: { all?: boolean } = {}): OAuthGrant[] {
    if (o.all) {
      if (!can(actor, "tokens.manage_all"))
        throw forbidden('requires the "tokens.manage_all" permission');
      return this.#d.grants.listAll();
    }
    return actor.kind === "user" ? this.#d.grants.listForUser(actor.userId) : [];
  }

  /** Someone else's grant is a 404, as with tokens. */
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

  /** A password reset or a disable ends every agent connection too, as it ends every session. */
  revokeAllFor(userId: string): void {
    this.#d.grants.revokeAllFor(userId);
  }
}

/** `oauth:<grantId>`: how an OAuth actor's tokenId reads, in the audit log and in the MCP surface's step-up. */
export const OAUTH_TOKEN_PREFIX = "oauth:";
export const isOAuthActor = (a: Actor): a is Extract<Actor, { kind: "token" }> =>
  a.kind === "token" && a.tokenId.startsWith(OAUTH_TOKEN_PREFIX);
