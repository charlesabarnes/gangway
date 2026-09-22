/**
 * A GitHub App, on plain `fetch` (ADR-0011). Two credentials, in order:
 *
 *   the App's private key  ->  a 10-minute RS256 JWT       (identifies the App)
 *   the JWT + an installation id  ->  an installation token (acts on that account's repos)
 *
 * Installation tokens live an hour; they are cached here until a minute before expiry and
 * minted once at a time per installation. They are what `git clone` and every REST call
 * present, and they never leave this process except inside those.
 */
import { createSign } from "node:crypto";
import { AppError, internal } from "../../errors.ts";
import { Logger } from "../../logger.ts";
import { SingleFlight } from "../../util/async.ts";

export const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";
/** GitHub rejects a JWT issued "in the future"; a minute of clock skew is its own advice. */
const JWT_SKEW_S = 60;
const JWT_LIFETIME_S = 600;
const TOKEN_MARGIN_MS = 60_000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type GitHubAppCredentials = {
  appId: string;
  /** PEM, PKCS#1 (`BEGIN RSA PRIVATE KEY`) as GitHub issues it, or PKCS#8. */
  privateKey: string;
};

export type GitHubAppOptions = {
  /** Read on every use, so a credential rotated in settings applies without a restart. */
  credentials: () => GitHubAppCredentials;
  fetch?: FetchLike | undefined;
  baseUrl?: string | undefined;
  log?: Logger | undefined;
  now?: (() => number) | undefined;
};

export type GitHubResponse<T> = { status: number; body: T; headers: Headers };

type CachedToken = { token: string; expiresAt: number };

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

export class GitHubApp {
  readonly #credentials: () => GitHubAppCredentials;
  readonly #fetch: FetchLike;
  readonly #base: string;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #tokens = new Map<string, CachedToken>();
  readonly #minting = new SingleFlight<CachedToken>();

  constructor(o: GitHubAppOptions) {
    this.#credentials = o.credentials;
    this.#fetch = o.fetch ?? ((url, init) => fetch(url, init));
    this.#base = (o.baseUrl ?? GITHUB_API).replace(/\/$/, "");
    this.#log = o.log ?? new Logger("info", { component: "forge/github" });
    this.#now = o.now ?? Date.now;
  }

  get baseUrl(): string { return this.#base; }

  /** The App's own JWT. Cheap to make; not cached, so a rotated key is used immediately. */
  jwt(): string {
    const { appId, privateKey } = this.#credentials();
    if (appId === "" || privateKey === "") throw new AppError("unprocessable", "the GitHub App is not configured (github.appId, github.privateKey)");
    const iat = Math.floor(this.#now() / 1000) - JWT_SKEW_S;
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(JSON.stringify({ iat, exp: iat + JWT_LIFETIME_S, iss: appId }));
    const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(privateKey);
    return `${header}.${claims}.${b64url(signature)}`;
  }

  /** An installation token, from the cache while it has a minute left. */
  async installationToken(installationId: string): Promise<string> {
    const cached = this.#tokens.get(installationId);
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > this.#now()) return cached.token;
    const fresh = await this.#minting.run(installationId, async () => {
      const again = this.#tokens.get(installationId);
      if (again && again.expiresAt - TOKEN_MARGIN_MS > this.#now()) return again;
      const r = await this.request<{ token?: string; expires_at?: string }>(
        "POST", `/app/installations/${encodeURIComponent(installationId)}/access_tokens`, { auth: `Bearer ${this.jwt()}` },
      );
      if (r.status !== 201 || typeof r.body?.token !== "string") {
        throw internal(`GitHub refused an installation token for ${installationId}: ${r.status}`, { status: r.status });
      }
      const expiresAt = r.body.expires_at ? Date.parse(r.body.expires_at) : this.#now() + 3_600_000;
      const minted = { token: r.body.token, expiresAt };
      this.#tokens.set(installationId, minted);
      this.#log.debug("installation token minted", { installationId, expiresAt: new Date(expiresAt).toISOString() });
      return minted;
    });
    return fresh.token;
  }

  /** Drops a cached token -- after a 401, so the next call mints instead of retrying a dead one. */
  forget(installationId: string): void { this.#tokens.delete(installationId); }

  /**
   * One REST call, JSON in and out. `auth` is the full Authorization value; callers pass
   * the JWT for App endpoints and `token <installation token>` for everything else.
   * Non-2xx is returned, not thrown: whether 404 is an error depends on the caller.
   */
  async request<T = unknown>(
    method: string, path: string, o: { auth: string; body?: unknown } ,
  ): Promise<GitHubResponse<T>> {
    const url = path.startsWith("https://") ? path : `${this.#base}${path}`;
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json", authorization: o.auth, "x-github-api-version": API_VERSION,
      "user-agent": "gangway",
    };
    const init: RequestInit = { method, headers };
    if (o.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(o.body);
    }
    const res = await this.#fetch(url, init);
    const text = await res.text();
    let body: T = undefined as T;
    if (text !== "") {
      try { body = JSON.parse(text) as T; } catch { body = text as unknown as T; }
    }
    if (res.status >= 500) {
      this.#log.warn("GitHub API error", { method, path, status: res.status });
    }
    return { status: res.status, body, headers: res.headers };
  }

  /** As an installation: mints (or reuses) the token and makes the call. */
  async asInstallation<T = unknown>(installationId: string, method: string, path: string, body?: unknown): Promise<GitHubResponse<T>> {
    const token = await this.installationToken(installationId);
    const r = await this.request<T>(method, path, body === undefined ? { auth: `token ${token}` } : { auth: `token ${token}`, body });
    if (r.status === 401) this.forget(installationId);
    return r;
  }
}
