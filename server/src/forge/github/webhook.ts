/**
 * GitHub's webhook wire format, and nothing else: the signature over the raw body, and the
 * three payloads we act on turned into `ForgeEvent`s. Pure functions; the fixtures in
 * the tests are trimmed real deliveries.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  parsePreviewCommand,
  type Association,
  type ForgeEvent,
  type ForgeRepo,
  type PullRequest,
} from "../forge.ts";

export const SIGNATURE_HEADER = "x-hub-signature-256";
export const EVENT_HEADER = "x-github-event";
export const DELIVERY_HEADER = "x-github-delivery";

/** `https://github.com/acme/web-app(.git)` -> `acme/web-app`; anything else -> null. */
export function githubFullName(cloneUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(cloneUrl);
  } catch {
    return null;
  }
  if (u.hostname.toLowerCase() !== "github.com") return null;
  const m = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u.pathname);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function signPayload(secret: string, rawBody: Uint8Array): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

/**
 * Constant-time on the digest. The header is parsed first so a wrong length is a plain
 * "no" and not an exception -- `timingSafeEqual` throws on unequal lengths.
 */
export function verifySignature(
  secret: string,
  rawBody: Uint8Array,
  header: string | null,
): boolean {
  if (secret === "" || header === null) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const presented = Buffer.from(m[1]!, "hex");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/* ------------------------------------------------------------------ payload shapes */
/* Only the fields read. GitHub sends far more; none of it is trusted beyond these. */

type GhUser = { login?: string };
type GhRepo = {
  full_name?: string;
  name?: string;
  owner?: GhUser;
  clone_url?: string;
  private?: boolean;
  fork?: boolean;
};
type GhPullRequest = {
  number?: number;
  title?: string;
  draft?: boolean;
  merged?: boolean;
  html_url?: string;
  user?: GhUser;
  head?: { sha?: string; ref?: string; repo?: GhRepo | null };
  base?: { ref?: string; repo?: GhRepo };
};
type GhPayload = {
  action?: string;
  repository?: GhRepo;
  installation?: { id?: number };
  pull_request?: GhPullRequest;
  issue?: { number?: number; pull_request?: unknown };
  comment?: { id?: number; body?: string; user?: GhUser; author_association?: string };
};

const PR_UPDATE_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

function repoOf(r: GhRepo | undefined, installationId: string): ForgeRepo | null {
  if (
    !r ||
    typeof r.full_name !== "string" ||
    typeof r.name !== "string" ||
    typeof r.clone_url !== "string"
  )
    return null;
  const owner = r.owner?.login ?? r.full_name.split("/")[0];
  if (typeof owner !== "string" || owner === "") return null;
  return {
    forge: "github",
    fullName: r.full_name,
    owner,
    name: r.name,
    cloneUrl: r.clone_url,
    installationId,
    private: r.private === true,
  };
}

/** Same reader for a webhook's `pull_request` and the REST `GET /pulls/{n}` body. */
export function pullRequestOf(p: GhPullRequest | undefined, repo: ForgeRepo): PullRequest | null {
  if (
    !p ||
    typeof p.number !== "number" ||
    typeof p.head?.sha !== "string" ||
    typeof p.head.ref !== "string"
  )
    return null;
  const headRepo = p.head.repo?.full_name;
  return {
    repo,
    number: p.number,
    title: p.title ?? "",
    headSha: p.head.sha,
    headRef: p.head.ref,
    baseRef: p.base?.ref ?? "",
    // A deleted head repository is `null`; treat what cannot be seen as foreign.
    fromFork: headRepo === undefined || headRepo === null || headRepo !== repo.fullName,
    draft: p.draft === true,
    author: p.user?.login ?? "",
    htmlUrl: p.html_url ?? "",
  };
}

export function associationOf(raw: string | undefined): Association {
  switch (raw) {
    case "OWNER":
      return "owner";
    case "MEMBER":
      return "member";
    case "COLLABORATOR":
      return "collaborator";
    default:
      return "other";
  }
}

export function parseGitHubEvent(event: string | null, payload: unknown): ForgeEvent {
  const p = (payload ?? {}) as GhPayload;
  const installationId = typeof p.installation?.id === "number" ? String(p.installation.id) : "";
  const repo = repoOf(p.repository, installationId);

  switch (event) {
    case "pull_request": {
      if (!repo) return { type: "ignored", reason: "pull_request without a repository" };
      if (installationId === "")
        return { type: "ignored", reason: "pull_request without an installation" };
      const pr = pullRequestOf(p.pull_request, repo);
      if (!pr) return { type: "ignored", reason: "pull_request without a head" };
      const action = p.action ?? "";
      if (action === "closed")
        return { type: "pr.closed", pr, merged: p.pull_request?.merged === true };
      if (PR_UPDATE_ACTIONS.has(action))
        return { type: "pr.updated", pr, action: action as "opened" };
      return { type: "ignored", reason: `pull_request.${action}` };
    }
    case "issue_comment": {
      if (p.action !== "created")
        return { type: "ignored", reason: `issue_comment.${p.action ?? ""}` };
      if (!repo) return { type: "ignored", reason: "issue_comment without a repository" };
      if (!p.issue?.pull_request || typeof p.issue.number !== "number")
        return { type: "ignored", reason: "a comment on an issue, not a pull request" };
      const command = parsePreviewCommand(p.comment?.body ?? "");
      if (command === null) return { type: "ignored", reason: "not a /preview command" };
      if (typeof p.comment?.id !== "number")
        return { type: "ignored", reason: "comment without an id" };
      return {
        type: "pr.command",
        repo,
        number: p.issue.number,
        ...command,
        commentId: p.comment.id,
        author: p.comment.user?.login ?? "",
        association: associationOf(p.comment.author_association),
      };
    }
    case "ping":
      return { type: "ignored", reason: "ping" };
    default:
      return { type: "ignored", reason: `event ${event ?? "(none)"}` };
  }
}
