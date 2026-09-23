import { type ForgeId, CLEARANCES, type Clearance } from "@gangway/shared/domain";

export type { ForgeId };

export type ForgeRepo = {
  forge: ForgeId;
  fullName: string;
  owner: string;
  name: string;
  cloneUrl: string;
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
  fromFork: boolean;
  draft: boolean;
  author: string;
  htmlUrl: string;
};

export type Association = "owner" | "member" | "collaborator" | "other";

export type PreviewCommand = "deploy" | "redeploy" | "destroy" | "status" | "secrets";
const PREVIEW_COMMANDS: readonly PreviewCommand[] = [
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
  // The raw body: the signature is over the bytes as sent.
  verify(
    headers: Headers,
    rawBody: Uint8Array,
  ): { ok: true; deliveryId: string } | { ok: false; reason: string };
  parse(headers: Headers, payload: unknown): ForgeEvent;
  pullRequest(repo: ForgeRepo, number: number): Promise<PullRequest>;
  cloneCredential(repo: ForgeRepo): Promise<string>;
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
