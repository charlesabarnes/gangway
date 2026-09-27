// Who may set which secrets (ADR-0034). Values are never read back through any of this.
import type { Preview, Project } from "@gangway/shared/domain";
import {
  DEFAULT_SECRET_TARGETS,
  targetPermissions,
  type Scope,
  type SecretTargets,
} from "@gangway/shared/permissions";
import { unprocessable } from "../errors.ts";
import { can, credentialOf, mayRebuild, type Actor, type Provenance } from "./actor.ts";

export type SecretTarget =
  | { kind: "org" }
  | { kind: "project"; project: Project }
  | {
      kind: "preview";
      preview: Preview;
      name: string;
      provenance: Provenance;
      project: Project | null;
    };

/** The targets a new credential is minted or granted with, checked against its maker's role. */
export function grantedTargets(
  maker: Actor,
  scopes: readonly Scope[],
  asked: SecretTargets | null | undefined,
): SecretTargets | null {
  if (!scopes.includes("secrets")) {
    if (asked) throw unprocessable("secretTargets needs the secrets scope");
    return null;
  }
  const targets = asked ?? DEFAULT_SECRET_TARGETS;
  if (targetPermissions(scopes, targets).some((p) => !can(maker, p)))
    throw unprocessable("your role does not cover project or org secrets", {
      missing: "repos.secrets",
    });
  return targets;
}

const targetsOf = (a: Actor): SecretTargets | undefined =>
  a.kind === "token" ? a.secretTargets : undefined;

function mayProject(a: Actor, project: Project): boolean {
  if (!can(a, "repos.secrets")) return false;
  const t = targetsOf(a);
  return !t || t.projects === "all" || t.projects.includes(project.id);
}

/** Null when the actor may set secrets here; otherwise why not, naming the target. */
export function secretRefusal(a: Actor, target: SecretTarget): string | null {
  const t = targetsOf(a);
  switch (target.kind) {
    case "org":
      if (!can(a, "repos.secrets") || (t && !t.org))
        return "this credential may not set org-wide secrets";
      return null;
    case "project":
      if (!mayProject(a, target.project))
        return `this credential may not set secrets on project "${target.project.slug}"`;
      return null;
    case "preview": {
      if (target.project && mayProject(a, target.project)) return null;
      const own =
        target.provenance.credential !== null && target.provenance.credential === credentialOf(a);
      if (
        can(a, "previews.secrets") &&
        mayRebuild(a, target.provenance) &&
        (!t || t.previews === "all" || own)
      )
        return null;
      return `this credential may not set secrets on preview ${target.name}${t?.previews === "own" ? ": it may set them only on previews it deployed" : ""}`;
    }
  }
}
