import type { addonQuery } from "@gangway/shared/api";
import { DEFAULT_ICON_COLOR, type PreviewIcon } from "@gangway/shared/preview-icon";
import { TemplateError } from "@gangway/shared/artifact/index";
import { BUILTIN_LIBRARY, type ArtifactLibrary } from "../artifacts/library.ts";
import { unprocessable } from "../errors.ts";
import type { DeploySource } from "../previews/deploy-types.ts";
import type { DeployArgs } from "./tool-specs.ts";
import type { CallScope } from "./tool-deps.ts";

export type Addons = ReturnType<typeof addonQuery.parse>;

// Checks on the deploy tool's arguments, and the deploy request they make.
export function checkRebuildArgs(args: DeployArgs): void {
  if (args.artifact !== undefined && (args.files !== undefined || args.upload !== undefined)) {
    throw unprocessable("preview + artifact rebuilds from the template; add files in a later call");
  }
  if (args.image !== undefined || args.git !== undefined) {
    throw unprocessable(
      "preview rebuilds from files or an upload; an image or a repository is a new deploy",
    );
  }
  if (args.ttl !== undefined) {
    throw unprocessable("a rebuild keeps the preview's expiry; change it with the extend tool");
  }
  if (args.upload !== undefined && (args.files !== undefined || args.remove !== undefined)) {
    throw unprocessable(
      "upload replaces the whole source; files and remove edit it -- give one or the other",
    );
  }
}

export function templateFiles(
  lib: ArtifactLibrary | undefined,
  input: NonNullable<DeployArgs["artifact"]>,
): Record<string, string> {
  try {
    return (lib ?? BUILTIN_LIBRARY).render(input);
  } catch (e) {
    if (e instanceof TemplateError) {
      throw unprocessable(`artifact: ${e.message}`);
    }
    throw e;
  }
}

export function sourcesGiven(args: DeployArgs): number {
  return [
    args.artifact !== undefined,
    args.files !== undefined,
    args.upload !== undefined,
    args.image !== undefined,
    args.git !== undefined,
  ].filter(Boolean).length;
}

export function iconOf(args: DeployArgs): PreviewIcon | undefined {
  if (args.icon === undefined) {
    if (args.iconColor !== undefined) {
      throw unprocessable("iconColor goes with icon");
    }
    return undefined;
  }
  return { name: args.icon, color: args.iconColor ?? DEFAULT_ICON_COLOR };
}

export const rebuildAsked = (args: DeployArgs, addons: Addons | undefined) =>
  [args.artifact, args.files, args.upload, args.remove, addons, args.network].some(
    (v) => v !== undefined,
  );

/** Nudges an agent that left out what the user finds a preview by. */
export function missingLabels(args: DeployArgs): string {
  const missing = [
    (args.title ?? args.artifact?.title) ? null : "title",
    args.icon ? null : "icon",
  ].filter(Boolean);
  if (missing.length === 0) {
    return "";
  }
  return `\nno ${missing.join(" or ")}: gangway lists it by its address until you set one. Deploy with preview: "<name>" and ${missing.join(" and ")} (no rebuild).`;
}

export function deployInput(
  scope: CallScope,
  args: DeployArgs,
  source: DeploySource,
  secrets: Record<string, string> | undefined,
) {
  const icon = iconOf(args);
  return {
    actor: scope.actor,
    source,
    name: args.name,
    title: args.title ?? args.artifact?.title?.slice(0, 100),
    ...(icon ? { icon } : {}),
    visibility: args.visibility,
    ttl: args.ttl,
    template: args.template,
    projectId: args.project,
    ...(args.password ? { password: { mode: args.password } } : {}),
    ...(args.passwordLogin ? { passwordLogin: args.passwordLogin } : {}),
    ...(args.watermark ? { watermark: args.watermark } : {}),
    ...(args.domain ? { domain: args.domain } : {}),
    ...(secrets ? { secrets } : {}),
  };
}

export const secretsAsked = (args: DeployArgs) =>
  args.secrets !== undefined || args.secretsUpload !== undefined || args.unsetSecrets !== undefined;
