import type { Preview } from "@gangway/shared/domain";
import type { AppError } from "../errors.ts";
import type { PreviewUrl } from "../previews/deploy.ts";
import type { PullRequest } from "./forge.ts";
import type { PrPreviewsDeps } from "./pr-previews.ts";

export type CommentPhase = "building" | "ready" | "failed" | "status";

export function commentBody(
  p: Preview,
  urls: PreviewUrl[],
  phase: CommentPhase,
  log: string | undefined,
): string {
  const sha = p.source.kind === "pr" ? p.source.sha.slice(0, 7) : "";
  const primary = urls.find((u) => u.primary) ?? urls[0];
  const lines: string[] = [];
  const state = phase === "status" ? p.state : phase;
  const title = {
    building: "🚧 Building preview",
    ready: "✅ Preview ready",
    failed: "❌ Preview failed",
    status: `Preview is **${p.state}**`,
  }[phase];
  lines.push(`### ${title}${sha ? ` for \`${sha}\`` : ""}`);
  if (p.secretLevel)
    lines.push(
      "",
      `_Secrets: **${p.secretLevel}**${p.secretLevel === "none" ? " (no .env)" : ""} · \`/preview secrets low|standard|high|none\` to change._`,
    );
  if (primary && state !== "failed") lines.push("", `**${primary.url}**`);
  if (urls.length > 1) lines.push("", ...urls.map((u) => `- \`${u.service}\`: ${u.url}`));
  if (p.state === "failed" && p.error) lines.push("", "```", p.error.slice(0, 2000), "```");
  lines.push(
    "",
    `${log ? `[Build log](${log}) · ` : ""}\`/preview redeploy\` · \`/preview destroy\` · \`/preview status\``,
  );
  if (p.ttlExpiresAt)
    lines.push(
      "",
      `_Expires ${p.ttlExpiresAt.toISOString().slice(0, 16).replace("T", " ")} UTC unless visited._`,
    );
  return lines.join("\n");
}

export function refusalBody(sha: string, e: AppError): string {
  return `### ❌ Preview refused for \`${sha.slice(0, 7)}\`\n\n${refusal(e)}\n\n\`/preview redeploy\` after a fix.`;
}

function refusal(e: AppError): string {
  const d = e.detail ?? {};
  const text = [d["compose"], d["reason"], d["message"]].find(
    (v) => typeof v === "string" && v.trim() !== "",
  ) as string | undefined;
  // Compose lists unset-variable warnings before the actual error.
  const shown = text
    ?.split(/\r?\n/)
    .filter((l) => !/^time="[^"]*" level=warning /.test(l))
    .join("\n")
    .trim();
  return shown ? `${e.message}\n\n\`\`\`\n${shown.slice(-1500)}\n\`\`\`` : e.message;
}

export async function postComment(
  d: Pick<PrPreviewsDeps, "forge" | "logger">,
  pr: Pick<PullRequest, "repo" | "number">,
  existingId: number | null,
  body: string,
): Promise<number | null> {
  try {
    return await d.forge.upsertComment(pr, existingId, body);
  } catch (e) {
    d.logger.warn("forge comment not written", {
      repo: pr.repo.fullName,
      number: pr.number,
      err: e,
    });
    return existingId;
  }
}
