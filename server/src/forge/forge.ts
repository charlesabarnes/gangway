/**
 * The forge abstraction (ADR-0011): what a git hosting service has to be able to do for
 * pull-request previews. GitHub is the only implementation; the PR lifecycle
 * (`pr-previews.ts`) is written against this and never imports it.
 *
 * Deliberately small. A forge receives a webhook, hands out a clone credential, keeps
 * ONE status comment per pull request current, and publishes a deployment status. What it
 * does NOT do is decide anything: whose PRs deploy, under what name, and whether a fork is
 * built are the lifecycle's questions, answered from `repos` rows, and a second forge must
 * not get to answer them differently.
 */

import { type ForgeId, CLEARANCES, type Clearance } from "../../../shared/src/domain.ts";

export type { ForgeId };

export type ForgeRepo = {
  forge: ForgeId;
  /** `owner/name` as the forge spells it. The identity of a `repos` row. */
  fullName: string;
  owner: string;
  name: string;
  /** Where `git clone` goes. HTTPS; the credential is supplied separately (git.ts). */
  cloneUrl: string;
  /** The forge-side grant the credential is minted from (a GitHub App installation). */
  installationId: string;
  private: boolean;
};

export type PullRequest = {
  repo: ForgeRepo;
  number: number;
  title: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  /** The head lives in another repository. §9: such a PR gets nothing unless someone asks. */
  fromFork: boolean;
  draft: boolean;
  author: string;
  htmlUrl: string;
};

/**
 * How the forge relates the commenter to the repository. `other` is everyone who is not
 * an owner, an organization member or an invited collaborator -- contributors included:
 * having had a PR merged once is not a say over what runs on the Docker host.
 */
export type Association = "owner" | "member" | "collaborator" | "other";

export type PreviewCommand = "deploy" | "redeploy" | "destroy" | "status" | "secrets";
export const PREVIEW_COMMANDS: readonly PreviewCommand[] = [
  "deploy",
  "redeploy",
  "destroy",
  "status",
  "secrets",
];
export type ParsedCommand =
  { command: Exclude<PreviewCommand, "secrets"> } | { command: "secrets"; level: Clearance };

export type ForgeEvent =
  | {
      type: "pr.updated";
      pr: PullRequest;
      action: "opened" | "reopened" | "synchronize" | "ready_for_review";
    }
  | { type: "pr.closed"; pr: PullRequest; merged: boolean }
  /** `/preview <command>` in a comment. The PR itself is fetched when it is needed. */
  | ({
      type: "pr.command";
      repo: ForgeRepo;
      number: number;
      author: string;
      association: Association;
      commentId: number;
    } & ParsedCommand)
  | { type: "ignored"; reason: string };

export type DeploymentState = "in_progress" | "success" | "failure" | "inactive";

export type Forge = {
  readonly id: ForgeId;
  /**
   * Authenticates a delivery. The raw body, because the signature is over the bytes as
   * sent; a re-serialized JSON object would not verify.
   */
  verify(
    headers: Headers,
    rawBody: Uint8Array,
  ): { ok: true; deliveryId: string } | { ok: false; reason: string };
  /** Turns an authenticated delivery into a `ForgeEvent`. Never throws on a strange payload: `ignored`. */
  parse(headers: Headers, payload: unknown): ForgeEvent;
  pullRequest(repo: ForgeRepo, number: number): Promise<PullRequest>;
  /** A short-lived credential `cloneRepo` can present. A value to pass along, never to store. */
  cloneCredential(repo: ForgeRepo): Promise<string>;
  /** Creates or edits the one comment gangway owns on a PR; returns its id. */
  upsertComment(
    pr: Pick<PullRequest, "repo" | "number">,
    existingId: number | null,
    body: string,
  ): Promise<number>;
  createDeployment(pr: Pick<PullRequest, "repo" | "headSha">, environment: string): Promise<number>;
  setDeploymentStatus(
    repo: ForgeRepo,
    deploymentId: number,
    state: DeploymentState,
    o?: { environmentUrl?: string; logUrl?: string },
  ): Promise<void>;
};

/**
 * `/preview deploy`, `/preview   status` -- the FIRST line of a comment, so a sentence that
 * mentions the command in passing is not one. Case-insensitive on the verb.
 */
export function parsePreviewCommand(body: string): ParsedCommand | null {
  const first = body.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const m = /^\/preview\s+([a-z]+)(?:\s+([a-z]+))?\s*$/i.exec(first);
  if (!m) return null;
  const verb = m[1]!.toLowerCase();
  const arg = m[2]?.toLowerCase();
  if (verb === "secrets")
    return arg !== undefined && (CLEARANCES as readonly string[]).includes(arg)
      ? { command: "secrets", level: arg as Clearance }
      : null;
  if (arg !== undefined) return null;
  return (PREVIEW_COMMANDS as readonly string[]).includes(verb)
    ? { command: verb as Exclude<PreviewCommand, "secrets"> }
    : null;
}
