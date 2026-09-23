import { randomBytes } from "node:crypto";
import { slugify } from "@gangway/shared/hostname";
import type { RuntimeId } from "@gangway/shared/runtimes";
import { publicOriginFor } from "@gangway/shared/url";
import type { PreviewContext } from "./context.ts";
import type { DeploySource, PreviewUrl } from "./deploy-types.ts";

export function unguessable(): string {
  const alphabet = "abcdefghjkmnpqrstvwxyz0123456789";
  return Array.from(randomBytes(10), (b) => alphabet[b % 32]).join("");
}

const repoName = (repo: string) => repo.split("/").pop() ?? "repo";

export function defaultName(source: DeploySource, runtime: RuntimeId | null): string {
  switch (source.kind) {
    case "tarball":
      return runtime ? `${runtime}-${unguessable().slice(0, 4)}` : "preview";
    case "pr":
      return `${repoName(source.repo)}-pr-${source.number}`;
    case "pushed":
      return `${repoName(source.pr.repo)}-pr-${source.pr.number}`;
    case "git":
      return nameFrom(source.repo.replace(/\/+$/, "").replace(/\.git$/, ""));
    case "image":
      return nameFrom(source.image);
  }
}

function nameFrom(from: string): string {
  const last = from.split("/").pop() ?? from;
  return slugify(last.split(/[:@]/)[0] ?? last) || "preview";
}

export function urlsFor(
  ctx: Pick<PreviewContext, "table" | "origin">,
  previewId: string,
): PreviewUrl[] {
  return ctx.table
    .forPreview(previewId)
    .map((e) => ({
      service: e.service,
      url: `${publicOriginFor(e.hostname, ctx.origin)}/`,
      primary: e.primary,
    }))
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.service.localeCompare(b.service));
}
