import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
  type JsonWebKey,
  type JsonWebKeyInput,
  type KeyObject,
} from "node:crypto";
import { AppError, unauthorized } from "../errors.ts";
import type { Logger } from "../logger.ts";
import { Bounded } from "./limiter.ts";

/** Sign-in through any OpenID Connect provider: authorization code, PKCE, a verified ID token. */
export type SsoConfig = { issuer: string; clientId: string; clientSecret: string; label: string };

/** Who the provider says signed in. The email is verified by the provider. */
export type SsoIdentity = { issuer: string; subject: string; email: string };

export type SsoDeps = {
  config: () => SsoConfig | null;
  redirectUri: () => string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  logger?: Logger | undefined;
};

type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

type Pending = {
  verifier: string;
  nonce: string;
  next: string;
  issuer: string;
  clientId: string;
  expiresAt: number;
};

type Jwk = JsonWebKey & { kid?: string; kty?: string; alg?: string; use?: string };

const STATE_TTL_MS = 10 * 60_000;
const DISCOVERY_TTL_MS = 60 * 60_000;
const REFETCH_FLOOR_MS = 60_000;
const SKEW_S = 120;
const TIMEOUT_MS = 10_000;

const b64url = (b: Buffer) => b.toString("base64url");
const decode = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as unknown;
const trimSlash = (s: string) => {
  let end = s.length;
  while (end > 0 && s[end - 1] === "/") {
    end--;
  }
  return s.slice(0, end);
};

// The message a person sees when anything about the provider's answer is wrong. The detail goes
// to the log; telling a stranger which check failed helps nobody but them.
const FAILED = "sign-in with the identity provider failed; try again";

export class Sso {
  readonly #d: SsoDeps;
  readonly #fetch: NonNullable<SsoDeps["fetch"]>;
  readonly #now: () => number;
  // Server-side, keyed by `state`; the browser holds the same value in a cookie, so a callback
  // only completes in the browser that started it.
  readonly #pending = new Bounded<Pending>(10_000);
  #discovery: { issuer: string; doc: Discovery; at: number } | null = null;
  #keys: { uri: string; byKid: Map<string, KeyObject>; at: number } | null = null;

  constructor(d: SsoDeps) {
    this.#d = d;
    this.#fetch = d.fetch ?? ((url, init) => fetch(url, init));
    this.#now = d.now ?? Date.now;
  }

  get configured(): boolean {
    return this.#d.config() !== null;
  }

  label(): string | null {
    return this.#d.config()?.label ?? null;
  }

  /** The provider's authorization URL, and the state the caller puts in a cookie. */
  async begin(next: string): Promise<{ url: string; state: string }> {
    const config = this.#require();
    const doc = await this.#discover(config.issuer);
    const state = b64url(randomBytes(32));
    const verifier = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(32));
    this.#pending.set(state, {
      verifier,
      nonce,
      next,
      issuer: config.issuer,
      clientId: config.clientId,
      expiresAt: this.#now() + STATE_TTL_MS,
    });
    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", this.#d.redirectUri());
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
    url.searchParams.set("code_challenge_method", "S256");
    return { url: url.toString(), state };
  }

  /**
   * Finishes a sign-in: the state must match the cookie and still be pending (each is used once),
   * then the code is exchanged and the ID token checked. Throws a 401 on anything wrong.
   */
  async complete(o: {
    state: string;
    cookieState: string | undefined;
    code: string;
  }): Promise<SsoIdentity & { next: string }> {
    const pending = this.#pending.get(o.state);
    this.#pending.delete(o.state);
    const config = this.#require();
    if (
      !pending ||
      o.cookieState !== o.state ||
      pending.expiresAt < this.#now() ||
      pending.issuer !== config.issuer ||
      pending.clientId !== config.clientId
    ) {
      throw unauthorized("that sign-in expired or was started in another browser; try again");
    }
    try {
      const doc = await this.#discover(config.issuer);
      const idToken = await this.#exchange(doc, config, o.code, pending.verifier);
      const claims = await this.#verify(idToken, doc, config.clientId, pending.nonce);
      return { ...claims, next: pending.next };
    } catch (e) {
      if (e instanceof AppError && e.status === 401) {
        throw e;
      }
      this.#d.logger?.warn("an identity provider sign-in failed", {
        err: e instanceof Error ? e.message : String(e),
      });
      throw unauthorized(FAILED);
    }
  }

  #require(): SsoConfig {
    const config = this.#d.config();
    if (!config) {
      throw new AppError("not_found", "sign-in with an identity provider is not set up");
    }
    return config;
  }

  async #get(url: string): Promise<unknown> {
    const res = await this.#fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`${new URL(url).host} answered HTTP ${res.status}`);
    }
    return res.json();
  }

  async #discover(issuer: string): Promise<Discovery> {
    const hit = this.#discovery;
    if (hit?.issuer === issuer && this.#now() - hit.at < DISCOVERY_TTL_MS) {
      return hit.doc;
    }
    let doc: Discovery;
    try {
      doc = (await this.#get(`${trimSlash(issuer)}/.well-known/openid-configuration`)) as Discovery;
    } catch (e) {
      this.#d.logger?.warn("could not read the identity provider's discovery document", {
        issuer,
        err: e instanceof Error ? e.message : String(e),
      });
      throw new AppError("unavailable", "the identity provider is not answering; try again soon");
    }
    const https = (v: unknown) => typeof v === "string" && /^https:\/\/[^/]/.test(v);
    // The document must name the issuer it was fetched from (OpenID Connect Discovery 4.3).
    if (
      typeof doc.issuer !== "string" ||
      trimSlash(doc.issuer) !== trimSlash(issuer) ||
      !https(doc.authorization_endpoint) ||
      !https(doc.token_endpoint) ||
      !https(doc.jwks_uri)
    ) {
      throw new AppError("unavailable", "the identity provider's discovery document is not valid");
    }
    this.#discovery = { issuer, doc, at: this.#now() };
    return doc;
  }

  async #exchange(doc: Discovery, config: SsoConfig, code: string, verifier: string) {
    // client_secret_basic: each half form-encoded before base64 (RFC 6749 2.3.1).
    const basic = Buffer.from(
      `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`,
    ).toString("base64");
    const res = await this.#fetch(doc.token_endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.#d.redirectUri(),
        code_verifier: verifier,
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`the token endpoint answered HTTP ${res.status}`);
    }
    const body = (await res.json()) as { id_token?: unknown };
    if (typeof body.id_token !== "string") {
      throw new TypeError("the token endpoint returned no id_token");
    }
    return body.id_token;
  }

  async #verify(
    token: string,
    doc: Discovery,
    clientId: string,
    nonce: string,
  ): Promise<SsoIdentity> {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("the id_token is not a JWS");
    }
    const [h, p, sig] = parts as [string, string, string];
    const header = decode(h) as { alg?: unknown; kid?: unknown };
    const alg = header.alg;
    if (alg !== "RS256" && alg !== "ES256") {
      throw new Error(`the id_token is signed with ${String(alg)}, not RS256 or ES256`);
    }
    const key = await this.#key(
      doc.jwks_uri,
      typeof header.kid === "string" ? header.kid : null,
      alg,
    );
    const data = Buffer.from(`${h}.${p}`);
    const signature = Buffer.from(sig, "base64url");
    const ok =
      alg === "RS256"
        ? verifySignature("RSA-SHA256", data, key, signature)
        : verifySignature("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature);
    if (!ok) {
      throw new Error("the id_token signature does not verify");
    }
    const c = decode(p) as Record<string, unknown>;
    checkClaims(c, { issuer: doc.issuer, clientId, nonce, now: Math.floor(this.#now() / 1000) });
    const subject = c["sub"];
    const email = c["email"];
    if (typeof subject !== "string" || subject === "") {
      throw new Error("the id_token has no subject");
    }
    if (typeof email !== "string" || email === "" || c["email_verified"] !== true) {
      throw unauthorized("the identity provider did not confirm your email address");
    }
    return { issuer: doc.issuer, subject, email: email.trim().toLowerCase() };
  }

  async #key(uri: string, kid: string | null, alg: "RS256" | "ES256"): Promise<KeyObject> {
    const pick = () => {
      const keys = this.#keys?.uri === uri ? this.#keys.byKid : undefined;
      if (!keys) {
        return undefined;
      }
      if (kid !== null) {
        return keys.get(kid);
      }
      // No kid: acceptable only when there is exactly one key that fits the algorithm.
      const fitting = [...keys.entries()].filter(([k]) => k.startsWith(`${alg}:`));
      return fitting.length === 1 ? fitting[0]?.[1] : undefined;
    };
    const stale =
      !this.#keys || this.#keys.uri !== uri || this.#now() - this.#keys.at > DISCOVERY_TTL_MS;
    let key = stale ? undefined : pick();
    if (!key && (stale || this.#now() - (this.#keys?.at ?? 0) > REFETCH_FLOOR_MS)) {
      await this.#loadKeys(uri);
      key = pick();
    }
    if (!key) {
      throw new Error(`no signing key ${kid ?? "(no kid)"} at the provider`);
    }
    return key;
  }

  async #loadKeys(uri: string): Promise<void> {
    const { keys } = (await this.#get(uri)) as { keys?: Jwk[] };
    const byKid = new Map<string, KeyObject>();
    for (const [i, k] of (keys ?? []).entries()) {
      if (k.use !== undefined && k.use !== "sig") {
        continue;
      }
      const alg = algOf(k);
      if (alg === null) {
        continue;
      }
      try {
        const key = createPublicKey({ key: k as JsonWebKeyInput["key"], format: "jwk" });
        byKid.set(k.kid ?? `${alg}:#${i}`, key);
        if (k.kid === undefined) {
          continue;
        }
        // Also findable by algorithm, for a token that names no kid.
        byKid.set(`${alg}:${k.kid}`, key);
      } catch {
        // One malformed key must not hide the others.
      }
    }
    this.#keys = { uri, byKid, at: this.#now() };
  }
}

function algOf(k: Jwk): "RS256" | "ES256" | null {
  if (k.kty === "RSA") {
    return "RS256";
  }
  return k.kty === "EC" && k.crv === "P-256" ? "ES256" : null;
}

/** The ID token's claims, per OpenID Connect Core 3.1.3.7. Throws on the first that fails. */
function checkClaims(
  c: Record<string, unknown>,
  {
    issuer,
    clientId,
    nonce,
    now,
  }: { issuer: string; clientId: string; nonce: string; now: number },
): void {
  const aud = c["aud"];
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (c["iss"] !== issuer) {
    throw new Error("the id_token names another issuer");
  }
  if (!audiences.includes(clientId)) {
    throw new Error("the id_token is for another client");
  }
  // With several audiences, azp must name us.
  if ((audiences.length > 1 || c["azp"] !== undefined) && c["azp"] !== clientId) {
    throw new Error("the id_token was issued to another party");
  }
  if (typeof c["exp"] !== "number" || c["exp"] + SKEW_S < now) {
    throw new Error("the id_token has expired");
  }
  if (typeof c["nbf"] === "number" && c["nbf"] - SKEW_S > now) {
    throw new Error("the id_token is not yet valid");
  }
  if (typeof c["iat"] === "number" && c["iat"] - SKEW_S > now) {
    throw new Error("the id_token is from the future");
  }
  if (c["nonce"] !== nonce) {
    throw new Error("the id_token nonce does not match");
  }
}
