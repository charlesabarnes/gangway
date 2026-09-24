import { lintMarkdown, type LintResult } from "../artifact/lint.ts";
import { lintHtml, usesKit } from "../artifact/lint-html.ts";
import { ARTIFACT_FILE } from "../artifact/vocab.ts";
import { MAX_PLAN_FILE_BYTES } from "./config.ts";
import type { RuleContext } from "./rule-context.ts";
import type { ArtifactMeta } from "./types.ts";

function record(
  ctx: RuleContext,
  file: string,
  r: LintResult,
  format: ArtifactMeta["format"],
): void {
  const { plan } = ctx;
  if (r.issues.length > 0 || !r.info) {
    const then = r.issues.map((i) => `line ${i.line}: ${i.message}`).join("; ");
    plan.reasons.push({ level: "error", found: file, then: then || "not an artifact" });
    return;
  }
  plan.artifact = { ...r.info, format };
  plan.reasons.push({
    level: "info",
    found: `${file} (a ${r.info.kind})`,
    then:
      format === "markdown"
        ? "renders it in gangway's style; the other files are served beside it"
        : "serves it with gangway's elements at /_gangway/",
  });
}

export function planArtifact(ctx: RuleContext): boolean {
  const { plan, have, text } = ctx;
  const html = have.has("index.html") ? text("index.html") : undefined;
  if (html !== undefined && usesKit(html)) {
    plan.serve = { kind: "static", output: false, fallback: "spa" };
    record(ctx, "index.html", lintHtml(html), "html");
    return true;
  }
  if (!have.has(ARTIFACT_FILE) || have.has("index.html")) return false;
  plan.serve = { kind: "static", output: false, fallback: "spa" };
  const body = text(ARTIFACT_FILE);
  if (body === undefined) {
    plan.reasons.push({
      level: "error",
      found: ARTIFACT_FILE,
      then: `larger than ${MAX_PLAN_FILE_BYTES / 1024} KiB; move rows into data/*.csv files`,
    });
    return true;
  }
  record(ctx, ARTIFACT_FILE, lintMarkdown(body, { has: (p) => have.has(p) }), "markdown");
  return true;
}
