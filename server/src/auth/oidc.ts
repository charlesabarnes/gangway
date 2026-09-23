/**
 * GitHub Actions OIDC: a workflow run proves which repository it runs in with
 * a JWT GitHub signs, minted for the audience we name (our API origin) and valid for
 * minutes. Nothing is stored and nothing is rotated: the key set is GitHub's, fetched
 * and cached, and the token is checked on every request like any bearer credential.
 *
 * What is checked: RS256 against a key from the issuer's JWKS, `iss` exactly, `aud`
 * exactly, `exp`/`nbf`/`iat` with a minute of skew, and a `repository` claim shaped like
 * `owner/name`. What the run may do is decided elsewhere: its actor reaches only
 * `/v1/projects/:ref/pulls/:n`, for the project whose repository the claim names.
 */
import {
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey,
  type JsonWebKeyInput,
  type KeyObject,
} from "node:crypto";
import type { Logger } from "../logger.ts";

export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";

export type WorkflowClaims = {
  repository: string;
  repositoryId: string;
  eventName: string;
  /** `refs/pull/<n>/merge` on a pull_request event. */
  ref: string;
  sha: string;
  runId: string;
  /** Whoever triggered the run. For the audit line. */
  actor: string;
};

export type OidcOptions = {
  /** The audience a token must carry: our public API origin. Read per request. */
  audience: () => string;
  issuer?: string;
  fetch?: (url: string) => Promise<Response>;
  now?: () => number;
  logger?: Logger;
};

type Jwk = JsonWebKey & { kid?: string };
const SKEW_S = 60;
const CACHE_MS = 60 * 60_000;
const REFETCH_FLOOR_MS = 60_000;

const b64url = (s: string) => Buffer.from(s, "base64url");
const looksLikeJwt = (s: string) => /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(s);

export class GitHubOidc {
  readonly #o: Required<Omit<OidcOptions, "logger">> & { logger?: Logger | undefined };
  #keys = new Map<string, KeyObject>();
  #fetchedAt = 0;
  #inflight: Promise<void> | null = null;

  constructor(o: OidcOptions) {
    this.#o = { issuer: GITHUB_ACTIONS_ISSUER, fetch: (u) => fetch(u), now: Date.now, ...o };
  }

  /** The claims, or null for anything that is not a valid token of ours. Never throws. */
  async verify(token: string): Promise<WorkflowClaims | null> {
    if (!looksLikeJwt(token)) return null;
    try {
      const [h, p, sig] = token.split(".") as [string, string, string];
      const header = JSON.parse(b64url(h).toString("utf8")) as { alg?: string; kid?: string };
      if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
      const claims = JSON.parse(b64url(p).toString("utf8")) as Record<string, unknown>;
      // Cheap checks before a network fetch: a stranger's JWT must not make us fetch keys.
      if (claims["iss"] !== this.#o.issuer) return null;
      const aud = claims["aud"];
      const audience = this.#o.audience();
      if (!(aud === audience || (Array.isArray(aud) && aud.includes(audience)))) return null;
      const now = Math.floor(this.#o.now() / 1000);
      if (typeof claims["exp"] !== "number" || claims["exp"] + SKEW_S < now) return null;
      if (typeof claims["nbf"] === "number" && claims["nbf"] - SKEW_S > now) return null;
      if (typeof claims["iat"] === "number" && claims["iat"] - SKEW_S > now) return null;

      const key = await this.#key(header.kid);
      if (!key) return null;
      const ok = verifySignature("RSA-SHA256", Buffer.from(`${h}.${p}`), key, b64url(sig));
      if (!ok) return null;

      const repository = claims["repository"];
      if (typeof repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repository)) return null;
      const str = (k: string) => (typeof claims[k] === "string" ? claims[k] : "");
      return {
        repository,
        repositoryId: str("repository_id"),
        eventName: str("event_name"),
        ref: str("ref"),
        sha: str("sha"),
        runId: str("run_id"),
        actor: str("actor"),
      };
    } catch (e) {
      this.#o.logger?.warn("an OIDC token could not be checked", { err: e });
      return null;
    }
  }

  /** From the cache; an unknown kid refetches the set at most once a minute (keys rotate). */
  async #key(kid: string): Promise<KeyObject | undefined> {
    const now = this.#o.now();
    const stale = now - this.#fetchedAt > CACHE_MS;
    if (stale || (!this.#keys.has(kid) && now - this.#fetchedAt > REFETCH_FLOOR_MS))
      await this.#refresh();
    return this.#keys.get(kid);
  }

  #refresh(): Promise<void> {
    this.#inflight ??= (async () => {
      try {
        const res = await this.#o.fetch(`${this.#o.issuer}/.well-known/jwks`);
        if (!res.ok) throw new Error(`jwks answered ${res.status}`);
        const { keys } = (await res.json()) as { keys?: Jwk[] };
        const next = new Map<string, KeyObject>();
        for (const k of keys ?? [])
          if (k.kid && k.kty === "RSA")
            next.set(
              k.kid,
              createPublicKey({
                key: k as JsonWebKeyInput["key"],
                format: "jwk",
              }),
            );
        this.#keys = next;
        this.#fetchedAt = this.#o.now();
      } catch (e) {
        // Keep the old set: a GitHub blip must not log every workflow out.
        this.#fetchedAt = this.#o.now();
        this.#o.logger?.warn("could not fetch GitHub's OIDC keys", { err: e });
      } finally {
        this.#inflight = null;
      }
    })();
    return this.#inflight;
  }
}
