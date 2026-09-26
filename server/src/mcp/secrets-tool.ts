import { mayRebuild, type Actor } from "../auth/actor.ts";
import type { SecretTarget } from "../auth/secret-access.ts";
import { notFound, unprocessable } from "../errors.ts";
import { changeSecrets, listSecrets, type SecretChangeDeps } from "../secrets/change.ts";
import type { SecretChange, SecretEntry } from "../secrets/secrets.ts";
import { nameOf, resolveFor } from "./resolve.ts";
import type { SecretUploads } from "./secret-uploads.ts";
import type { ToolDeps } from "./tool-deps.ts";
import type { SecretsArgs } from "./setup-tool-specs.ts";

function changeDeps(d: ToolDeps): SecretChangeDeps {
  if (!d.ctx.secrets) throw notFound("secrets are not available on this server");
  return { secrets: d.ctx.secrets, previews: d.ctx.previews };
}

export function secretUploads(d: ToolDeps): SecretUploads {
  if (!d.secretUploads) throw unprocessable("secret uploads are not available on this server");
  return d.secretUploads;
}

/** A preview, project or the org, found as this actor may see it. */
export function secretTarget(
  d: ToolDeps,
  actor: Actor,
  t: NonNullable<SecretsArgs["target"]>,
): SecretTarget {
  if ("org" in t) return { kind: "org" };
  if ("project" in t) {
    const project = d.findProject?.(t.project);
    if (!project) throw notFound(`no such project: ${t.project}`);
    return { kind: "project", project };
  }
  const preview = resolveFor(d.ctx, actor, t.preview);
  const project = preview.projectId ? (d.findProject?.(preview.projectId) ?? null) : null;
  return {
    kind: "preview",
    preview,
    name: nameOf(d.ctx, preview),
    provenance: d.ctx.previews.provenanceOf(preview.id),
    project,
  };
}

const where = (t: SecretTarget) =>
  t.kind === "org" ? "the org" : t.kind === "project" ? `project "${t.project.slug}"` : t.name;

export function uploadCommand(d: ToolDeps, actor: Actor): string {
  const u = secretUploads(d).issue(actor);
  const mins = Math.round((u.expiresAt - d.ctx.now()) / 60_000);
  return [
    `secret upload URL ready: one use, ${mins} min, at most 64 KB of NAME=value lines. From the directory with the file:`,
    "",
    `  curl -sS --fail-with-body -X PUT --data-binary @.env '${u.url}'`,
    "",
    `It answers with the names it read, never the values. Then call secrets with upload: "${u.id}" and the target, or deploy with secretsUpload: "${u.id}".`,
  ].join("\n");
}

export function setSecrets(d: ToolDeps, actor: Actor, args: SecretsArgs): string {
  if (args.upload === "new") return uploadCommand(d, actor);
  if (!args.target) throw unprocessable("target: {preview}, {project} or {org: true}");
  const target = secretTarget(d, actor, args.target);
  const uploaded = args.upload ? secretUploads(d).take(args.upload, actor) : {};
  const level = args.level;
  const set: Record<string, string | SecretEntry> = {
    ...Object.fromEntries(
      Object.entries(uploaded).map(([k, v]) => [k, level ? { value: v, level } : v]),
    ),
    ...args.set,
  };
  const change: SecretChange = {
    ...(Object.keys(set).length > 0 ? { set } : {}),
    ...(args.unset?.length ? { unset: args.unset } : {}),
    ...(args.levels && Object.keys(args.levels).length > 0 ? { levels: args.levels } : {}),
  };
  const deps = changeDeps(d);
  if (Object.keys(change).length === 0) {
    const names = listSecrets(deps, actor, target);
    return `${names.length} secret${names.length === 1 ? "" : "s"} at ${where(target)}${names.length ? ":" : "."}${names.map((s) => `\n  ${s.name} (${s.level})`).join("")}\nValues are never shown.`;
  }
  const out = changeSecrets(deps, actor, target, change);
  const rebuild =
    target.kind === "preview" &&
    target.preview.source.kind === "tarball" &&
    mayRebuild(actor, target.provenance)
      ? `\nTo apply it now: deploy with preview: "${target.name}" and secrets: {} (or any change).`
      : "";
  return `${out.secrets.length} secret${out.secrets.length === 1 ? "" : "s"} at ${where(target)}:${out.secrets.map((s) => `\n  ${s.name}${target.kind === "preview" ? "" : ` (${s.level})`}`).join("")}\n${out.appliesTo}.${rebuild}`;
}
