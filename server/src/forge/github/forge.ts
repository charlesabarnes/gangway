/**
 * `Forge` for GitHub (ADR-0011). Everything here is one of six REST calls on top of
 * `GitHubApp`; the lifecycle decisions live in `forge/pr-previews.ts`.
 */
import { internal, notFound } from "../../errors.ts";
import type { DeploymentState, Forge, ForgeEvent, ForgeRepo, PullRequest } from "../forge.ts";
import type { GitHubApp } from "./app.ts";
import { DELIVERY_HEADER, EVENT_HEADER, SIGNATURE_HEADER, parseGitHubEvent, pullRequestOf, verifySignature } from "./webhook.ts";

/** Marks the comment as ours. Invisible on GitHub; found by substring, never by position. */
export const COMMENT_MARKER = "<!-- gangway -->";

export type GitHubForgeOptions = {
  app: GitHubApp;
  /** Read per delivery: a rotated webhook secret applies to the next one. */
  webhookSecret: () => string;
};

const repoPath = (r: ForgeRepo) => `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`;

export class GitHubForge implements Forge {
  readonly id = "github" as const;
  readonly #app: GitHubApp;
  readonly #secret: () => string;

  constructor(o: GitHubForgeOptions) {
    this.#app = o.app;
    this.#secret = o.webhookSecret;
  }

  verify(headers: Headers, rawBody: Uint8Array): { ok: true; deliveryId: string } | { ok: false; reason: string } {
    const secret = this.#secret();
    if (secret === "") return { ok: false, reason: "no webhook secret is configured" };
    if (!verifySignature(secret, rawBody, headers.get(SIGNATURE_HEADER))) return { ok: false, reason: "bad signature" };
    const deliveryId = headers.get(DELIVERY_HEADER) ?? "";
    if (deliveryId === "") return { ok: false, reason: "no delivery id" };
    return { ok: true, deliveryId };
  }

  parse(headers: Headers, payload: unknown): ForgeEvent {
    return parseGitHubEvent(headers.get(EVENT_HEADER), payload);
  }

  async pullRequest(repo: ForgeRepo, number: number): Promise<PullRequest> {
    const r = await this.#app.asInstallation<Parameters<typeof pullRequestOf>[0]>(repo.installationId, "GET", `${repoPath(repo)}/pulls/${number}`);
    if (r.status === 404) throw notFound(`${repo.fullName}#${number} does not exist or the App cannot see it`);
    const pr = r.status === 200 ? pullRequestOf(r.body, repo) : null;
    if (!pr) throw internal(`GitHub answered ${r.status} for ${repo.fullName}#${number}`, { status: r.status });
    return pr;
  }

  cloneCredential(repo: ForgeRepo): Promise<string> {
    return this.#app.installationToken(repo.installationId);
  }

  async upsertComment(pr: Pick<PullRequest, "repo" | "number">, existingId: number | null, body: string): Promise<number> {
    const marked = body.includes(COMMENT_MARKER) ? body : `${COMMENT_MARKER}\n${body}`;
    const base = repoPath(pr.repo);
    if (existingId !== null) {
      const r = await this.#app.asInstallation<{ id?: number }>(pr.repo.installationId, "PATCH", `${base}/issues/comments/${existingId}`, { body: marked });
      if (r.status === 200) return existingId;
      // Deleted by a human: fall through and make a new one. Anything else is an error.
      if (r.status !== 404) throw internal(`GitHub answered ${r.status} editing comment ${existingId}`, { status: r.status });
    }
    const r = await this.#app.asInstallation<{ id?: number }>(pr.repo.installationId, "POST", `${base}/issues/${pr.number}/comments`, { body: marked });
    if (r.status !== 201 || typeof r.body?.id !== "number") throw internal(`GitHub answered ${r.status} creating a comment on #${pr.number}`, { status: r.status });
    return r.body.id;
  }

  async createDeployment(pr: Pick<PullRequest, "repo" | "headSha">, environment: string): Promise<number> {
    const r = await this.#app.asInstallation<{ id?: number; message?: string }>(pr.repo.installationId, "POST", `${repoPath(pr.repo)}/deployments`, {
      ref: pr.headSha, environment, auto_merge: false, required_contexts: [],
      transient_environment: true, production_environment: false, description: "gangway preview",
    });
    if (r.status !== 201 || typeof r.body?.id !== "number") {
      throw internal(`GitHub answered ${r.status} creating a deployment: ${r.body?.message ?? ""}`.trim(), { status: r.status });
    }
    return r.body.id;
  }

  async setDeploymentStatus(repo: ForgeRepo, deploymentId: number, state: DeploymentState, o: { environmentUrl?: string; logUrl?: string } = {}): Promise<void> {
    const body: Record<string, unknown> = { state, auto_inactive: false };
    if (o.environmentUrl !== undefined) body["environment_url"] = o.environmentUrl;
    if (o.logUrl !== undefined) body["log_url"] = o.logUrl;
    const r = await this.#app.asInstallation(repo.installationId, "POST", `${repoPath(repo)}/deployments/${deploymentId}/statuses`, body);
    if (r.status !== 201) throw internal(`GitHub answered ${r.status} setting deployment ${deploymentId} to ${state}`, { status: r.status });
  }
}
