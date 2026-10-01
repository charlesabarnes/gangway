// Listing and changing secrets at one target, shared by the REST routes and the MCP secrets tool.
import { pullRequestOf, type Preview } from "@gangway/shared/domain";
import type { Actor } from "../auth/actor.ts";
import { secretRefusal, type SecretTarget } from "../auth/secret-access.ts";
import type { PreviewsRepo } from "../db/repos/previews.ts";
import { forbidden } from "../errors.ts";
import type { SecretChange, SecretListing, Secrets } from "./secrets.ts";

export type SecretChangeDeps = {
  secrets: Secrets;
  previews: Pick<PreviewsRepo, "list">;
};

const RUNNING: ReadonlySet<Preview["state"]> = new Set(["building", "starting", "awake", "asleep"]);

function mapFor(secrets: Secrets, target: SecretTarget) {
  if (target.kind === "org") {
    return secrets.global();
  }
  if (target.kind === "project") {
    return secrets.project(target.project.id);
  }
  return secrets.preview(target.preview.id);
}

function allow(actor: Actor, target: SecretTarget): void {
  const why = secretRefusal(actor, target);
  if (why) {
    throw forbidden(why);
  }
}

/** Names and levels only: no path returns a value. */
export function listSecrets(
  d: SecretChangeDeps,
  actor: Actor,
  target: SecretTarget,
): SecretListing[] {
  allow(actor, target);
  return mapFor(d.secrets, target).list();
}

export function changeSecrets(
  d: SecretChangeDeps,
  actor: Actor,
  target: SecretTarget,
  change: SecretChange,
): { secrets: SecretListing[]; appliesTo: string } {
  allow(actor, target);
  const secrets = mapFor(d.secrets, target).update(actor, change);
  return { secrets, appliesTo: appliesTo(d, target) };
}

/** Containers keep the env they started with, so say what has to happen for a change to land. */
export function appliesTo(d: SecretChangeDeps, target: SecretTarget): string {
  if (target.kind === "preview") {
    const source = target.preview.source;
    if (pullRequestOf(source)) {
      return `stored on ${target.name}; it takes effect on the pull request's next push, and is kept across pushes`;
    }
    if (source.kind === "tarball") {
      return `stored on ${target.name}; it takes effect on its next rebuild (deploy with preview: "${target.name}")`;
    }
    return `stored on ${target.name}; it takes effect when it is deployed again`;
  }
  const running = d.previews
    .list({})
    .filter(
      (p) => RUNNING.has(p.state) && (target.kind === "org" || p.projectId === target.project.id),
    ).length;
  const scope =
    target.kind === "org"
      ? "every preview whose clearance covers it"
      : `project "${target.project.slug}"'s previews`;
  return `applies to ${scope} from its next deploy or rebuild; ${running} running preview${running === 1 ? "" : "s"} keep${running === 1 ? "s" : ""} the values they started with until then`;
}
