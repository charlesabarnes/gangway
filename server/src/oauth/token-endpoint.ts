import { randomBytes, timingSafeEqual } from "node:crypto";
import type { OAuthGrant } from "@gangway/shared/domain";
import type { AuditSink } from "../audit/audit.ts";
import type { Actor } from "../auth/actor.ts";
import type { OAuthGrantsRepo } from "../db/repos/oauth-grants.ts";
import { sha256 } from "../util/hash.ts";
import { ulid } from "../util/ulid.ts";
import type { OAuthScope } from "./authorize-request.ts";

export const ACCESS_TTL_MS = 3_600_000;
export const REFRESH_IDLE_MS = 30 * 86_400_000;
const GRANT_ABSOLUTE_MS = 90 * 86_400_000;
// A rotated-away refresh token back within this window is the client racing itself: refuse it but keep the grant.
export const REFRESH_REUSE_GRACE_MS = 60_000;

const REFRESH_SHAPE = /^gwr_[A-Za-z0-9_-]{43}$/;
const secret = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;
const pkce = (verifier: string) => sha256(verifier, "base64url");

export const sameResource = (a: string, b: string) =>
  a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

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

export type Code = {
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
  actor: Actor;
};

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

type Issued = {
  access: string;
  refresh: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
};
type RefreshRecord = NonNullable<ReturnType<OAuthGrantsRepo["findByRefresh"]>>;

export type TokenEndpointDeps = {
  grants: OAuthGrantsRepo;
  audit: AuditSink;
  now: () => number;
};

const tokenResponse = (t: Issued, scopes: readonly string[]): TokenResponse => ({
  access_token: t.access,
  token_type: "Bearer",
  expires_in: Math.round(ACCESS_TTL_MS / 1000),
  refresh_token: t.refresh,
  scope: scopes.join(" "),
});

function checkVerifier(c: Code, form: URLSearchParams): void {
  const verifier = form.get("code_verifier") ?? "";
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
    throw new OAuthError("invalid_grant", "code_verifier is missing or malformed");
  const expected = Buffer.from(c.challenge);
  const got = Buffer.from(pkce(verifier));
  if (expected.length !== got.length || !timingSafeEqual(expected, got))
    throw new OAuthError("invalid_grant", "code_verifier does not match the code_challenge");
}

function checkRefreshRequest(rec: RefreshRecord, form: URLSearchParams, now: number): void {
  const { grant } = rec;
  if (form.get("client_id") !== grant.clientId)
    throw new OAuthError("invalid_grant", "the refresh token was issued to another client");
  const resource = form.get("resource");
  if (resource !== null && !sameResource(resource, rec.resource))
    throw new OAuthError("invalid_target", `tokens here are only for ${rec.resource}`);
  if (rec.refreshExpiresAt <= now || grant.expiresAt.getTime() <= now)
    throw new OAuthError("invalid_grant", "the grant has expired; connect again");
  if (rec.owner.disabled)
    throw new OAuthError("invalid_grant", "the account behind this grant is disabled");
  const asked = (form.get("scope") ?? "")
    .split(" ")
    .filter((s) => s !== "" && s !== "offline_access");
  if (asked.some((s) => !(grant.scopes as string[]).includes(s)))
    throw new OAuthError("invalid_scope", "a refresh cannot widen the grant");
}

export class TokenEndpoint {
  readonly #d: TokenEndpointDeps;
  readonly #codes = new Map<string, Code>();

  constructor(d: TokenEndpointDeps) {
    this.#d = d;
  }

  remember(code: string, c: Code): void {
    this.#codes.set(code, c);
  }

  sweep(now: number): void {
    for (const [k, c] of this.#codes) if (c.expiresAt <= now) this.#codes.delete(k);
  }

  token(form: URLSearchParams): TokenResponse {
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") return this.#exchange(form);
    if (grantType === "refresh_token") return this.#refresh(form);
    throw new OAuthError(
      "unsupported_grant_type",
      "grant_type must be authorization_code or refresh_token",
    );
  }

  #issue(): Issued {
    const now = this.#d.now();
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
    if (!c || c.expiresAt <= this.#d.now())
      throw new OAuthError("invalid_grant", "the authorization code is unknown or expired");
    if (c.used) {
      // A code used twice means someone else has it, so revoke what it made.
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
    checkVerifier(c, form);
    c.used = true;

    const t = this.#issue();
    const grant = this.#createGrant(c, t);
    c.grantId = grant.id;
    this.#d.audit.record(c.actor, "oauth.grant.created", grant.id, {
      new: {
        client: c.clientId,
        clientName: c.clientName,
        redirectUri: c.redirectUri,
        scopes: c.scopes,
      },
    });
    return tokenResponse(t, c.scopes);
  }

  #createGrant(c: Code, t: Issued): OAuthGrant {
    const now = this.#d.now();
    return this.#d.grants.create({
      id: ulid(now),
      userId: c.userId,
      clientId: c.clientId,
      clientName: c.clientName,
      redirectUri: c.redirectUri,
      scopes: c.scopes,
      resource: c.resource,
      accessHash: sha256(t.access, "hex"),
      accessExpiresAt: t.accessExpiresAt,
      refreshHash: sha256(t.refresh, "hex"),
      refreshExpiresAt: t.refreshExpiresAt,
      absoluteExpiresAt: now + GRANT_ABSOLUTE_MS,
    });
  }

  #refresh(form: URLSearchParams): TokenResponse {
    const presented = form.get("refresh_token") ?? "";
    if (!REFRESH_SHAPE.test(presented))
      throw new OAuthError("invalid_grant", "the refresh token is not valid");
    const hash = sha256(presented, "hex");
    const rec = this.#d.grants.findByRefresh(hash);
    if (!rec) {
      this.#revokeReplayed(hash);
      throw new OAuthError("invalid_grant", "the refresh token is not valid");
    }
    const { grant } = rec;
    checkRefreshRequest(rec, form, this.#d.now());

    const t = this.#issue();
    const refreshExpiresAt = Math.min(t.refreshExpiresAt, grant.expiresAt.getTime());
    if (
      !this.#d.grants.rotate(grant.id, hash, {
        accessHash: sha256(t.access, "hex"),
        accessExpiresAt: Math.min(t.accessExpiresAt, refreshExpiresAt),
        refreshHash: sha256(t.refresh, "hex"),
        refreshExpiresAt,
      })
    ) {
      throw new OAuthError("invalid_grant", "the refresh token is not valid");
    }
    return tokenResponse(t, grant.scopes);
  }

  #revokeReplayed(hash: string): void {
    const replayed = this.#d.grants.findByPreviousRefresh(hash);
    const racing =
      replayed?.rotatedAt != null && this.#d.now() - replayed.rotatedAt < REFRESH_REUSE_GRACE_MS;
    if (
      replayed &&
      !racing &&
      replayed.grant.revokedAt === null &&
      this.#d.grants.revoke(replayed.grant.id)
    ) {
      this.#d.audit.record(null, "oauth.grant.revoked", replayed.grant.id, {
        new: { reason: "refresh token replayed", client: replayed.grant.clientId },
      });
    }
  }
}
