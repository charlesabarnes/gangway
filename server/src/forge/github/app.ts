import { createSign } from "node:crypto";
import { AppError, internal } from "../../errors.ts";
import { Logger } from "../../logger.ts";
import { SingleFlight } from "../../util/async.ts";

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";
// GitHub rejects a JWT issued in the future, so backdate for clock skew.
const JWT_SKEW_S = 60;
const JWT_LIFETIME_S = 600;
const TOKEN_MARGIN_MS = 60_000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type GitHubAppCredentials = {
  appId: string;
  privateKey: string;
};

export type GitHubAppOptions = {
  credentials: () => GitHubAppCredentials;
  fetch?: FetchLike | undefined;
  baseUrl?: string | undefined;
  log?: Logger | undefined;
  now?: (() => number) | undefined;
};

export type GitHubResponse<T> = { status: number; body: T; headers: Headers };

type CachedToken = { token: string; expiresAt: number };

export type ManifestConversion = {
  appId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  privateKey: string;
  htmlUrl: string;
};

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

  get baseUrl(): string {
    return this.#base;
  }

  jwt(): string {
    const { appId, privateKey } = this.#credentials();
    if (appId === "" || privateKey === "")
      throw new AppError(
        "unprocessable",
        "the GitHub App is not configured (github.appId, github.privateKey)",
      );
    const iat = Math.floor(this.#now() / 1000) - JWT_SKEW_S;
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(JSON.stringify({ iat, exp: iat + JWT_LIFETIME_S, iss: appId }));
    const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(privateKey);
    return `${header}.${claims}.${b64url(signature)}`;
  }

  async installationToken(installationId: string): Promise<string> {
    const cached = this.#tokens.get(installationId);
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > this.#now()) return cached.token;
    const fresh = await this.#minting.run(installationId, async () => {
      const again = this.#tokens.get(installationId);
      if (again && again.expiresAt - TOKEN_MARGIN_MS > this.#now()) return again;
      const r = await this.request<{ token?: string; expires_at?: string }>(
        "POST",
        `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
        { auth: `Bearer ${this.jwt()}` },
      );
      if (r.status !== 201 || typeof r.body?.token !== "string") {
        throw internal(`GitHub refused an installation token for ${installationId}: ${r.status}`, {
          status: r.status,
        });
      }
      const expiresAt = r.body.expires_at ? Date.parse(r.body.expires_at) : this.#now() + 3_600_000;
      const minted = { token: r.body.token, expiresAt };
      this.#tokens.set(installationId, minted);
      this.#log.debug("installation token minted", {
        installationId,
        expiresAt: new Date(expiresAt).toISOString(),
      });
      return minted;
    });
    return fresh.token;
  }

  forget(installationId: string): void {
    this.#tokens.delete(installationId);
  }

  async request<T = unknown>(
    method: string,
    path: string,
    o: { auth: string; body?: unknown },
  ): Promise<GitHubResponse<T>> {
    const url = path.startsWith("https://") ? path : `${this.#base}${path}`;
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": API_VERSION,
      "user-agent": "gangway",
      ...(o.auth === "" ? {} : { authorization: o.auth }),
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
      try {
        body = JSON.parse(text) as T;
      } catch {
        body = text as unknown as T;
      }
    }
    if (res.status >= 500) {
      this.#log.warn("GitHub API error", { method, path, status: res.status });
    }
    return { status: res.status, body, headers: res.headers };
  }

  async convertManifest(code: string): Promise<ManifestConversion> {
    const r = await this.request<
      Partial<
        Record<
          | "id"
          | "slug"
          | "client_id"
          | "client_secret"
          | "webhook_secret"
          | "pem"
          | "html_url"
          | "message",
          unknown
        >
      >
    >("POST", `/app-manifests/${encodeURIComponent(code)}/conversions`, { auth: "" });
    const b = r.body ?? {};
    if (
      r.status !== 201 ||
      typeof b.id !== "number" ||
      typeof b.pem !== "string" ||
      typeof b.slug !== "string"
    ) {
      throw new AppError(
        r.status === 404 ? "unprocessable" : "internal",
        `GitHub did not convert the manifest (${r.status}): ${typeof b.message === "string" ? b.message : "the code may have been used already"}`,
        { status: r.status },
      );
    }
    return {
      appId: String(b.id),
      slug: b.slug,
      clientId: typeof b.client_id === "string" ? b.client_id : "",
      clientSecret: typeof b.client_secret === "string" ? b.client_secret : "",
      webhookSecret: typeof b.webhook_secret === "string" ? b.webhook_secret : "",
      privateKey: b.pem,
      htmlUrl: typeof b.html_url === "string" ? b.html_url : "",
    };
  }

  async installedRepositories(): Promise<
    { fullName: string; installationId: string; private: boolean }[]
  > {
    const installs = await this.request<{ id: number }[]>(
      "GET",
      "/app/installations?per_page=100",
      { auth: `Bearer ${this.jwt()}` },
    );
    if (installs.status !== 200 || !Array.isArray(installs.body))
      throw new AppError(
        "bad_gateway",
        `GitHub did not list the App's installations (${installs.status})`,
      );
    const out: { fullName: string; installationId: string; private: boolean }[] = [];
    for (const inst of installs.body) {
      const id = String(inst.id);
      const r = await this.asInstallation<{
        repositories?: { full_name: string; private: boolean }[];
      }>(id, "GET", "/installation/repositories?per_page=100");
      for (const repo of r.body?.repositories ?? [])
        out.push({ fullName: repo.full_name, installationId: id, private: repo.private });
    }
    return out.sort((x, y) => x.fullName.localeCompare(y.fullName));
  }

  async asInstallation<T = unknown>(
    installationId: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<GitHubResponse<T>> {
    const token = await this.installationToken(installationId);
    const r = await this.request<T>(
      method,
      path,
      body === undefined ? { auth: `token ${token}` } : { auth: `token ${token}`, body },
    );
    if (r.status === 401) this.forget(installationId);
    return r;
  }
}
