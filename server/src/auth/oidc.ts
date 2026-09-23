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
  ref: string;
  sha: string;
  runId: string;
  actor: string;
};

export type OidcOptions = {
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

type Claims = Record<string, unknown>;

function claimsAcceptable(claims: Claims, issuer: string, audience: string, now: number): boolean {
  if (claims["iss"] !== issuer) return false;
  const aud = claims["aud"];
  if (!(aud === audience || (Array.isArray(aud) && aud.includes(audience)))) return false;
  if (typeof claims["exp"] !== "number" || claims["exp"] + SKEW_S < now) return false;
  if (typeof claims["nbf"] === "number" && claims["nbf"] - SKEW_S > now) return false;
  return !(typeof claims["iat"] === "number" && claims["iat"] - SKEW_S > now);
}

function workflowClaims(claims: Claims): WorkflowClaims | null {
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
}

export class GitHubOidc {
  readonly #o: Required<Omit<OidcOptions, "logger">> & { logger?: Logger | undefined };
  #keys = new Map<string, KeyObject>();
  #fetchedAt = 0;
  #inflight: Promise<void> | null = null;

  constructor(o: OidcOptions) {
    this.#o = { issuer: GITHUB_ACTIONS_ISSUER, fetch: (u) => fetch(u), now: Date.now, ...o };
  }

  async verify(token: string): Promise<WorkflowClaims | null> {
    if (!looksLikeJwt(token)) return null;
    try {
      const [h, p, sig] = token.split(".") as [string, string, string];
      const header = JSON.parse(b64url(h).toString("utf8")) as { alg?: string; kid?: string };
      if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
      const claims = JSON.parse(b64url(p).toString("utf8")) as Claims;
      // Cheap checks first, so a stranger's JWT cannot make us fetch keys.
      const now = Math.floor(this.#o.now() / 1000);
      if (!claimsAcceptable(claims, this.#o.issuer, this.#o.audience(), now)) return null;

      const key = await this.#key(header.kid);
      if (!key) return null;
      const ok = verifySignature("RSA-SHA256", Buffer.from(`${h}.${p}`), key, b64url(sig));
      if (!ok) return null;

      return workflowClaims(claims);
    } catch (e) {
      this.#o.logger?.warn("an OIDC token could not be checked", { err: e });
      return null;
    }
  }

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
        this.#fetchedAt = this.#o.now();
        this.#o.logger?.warn("could not fetch GitHub's OIDC keys", { err: e });
      } finally {
        this.#inflight = null;
      }
    })();
    return this.#inflight;
  }
}
