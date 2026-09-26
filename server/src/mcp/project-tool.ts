import type { Actor } from "../auth/actor.ts";
import { notFound } from "../errors.ts";
import { createProject } from "../projects/create.ts";
import { WORKFLOW_PATH_IN_REPO, workflowFor } from "../projects/workflow.ts";
import type { ToolDeps } from "./tool-deps.ts";
import type { ProjectArgs } from "./tool-specs.ts";

/** Find or make the repository's workflow project and hand back the file that previews its PRs. */
export function connectProject(d: ToolDeps, actor: Actor, args: ProjectArgs): string {
  const p = d.projects;
  if (!p) throw notFound("projects are not available on this server");
  const existing = p.repo.getByFullName("github", args.repository);
  const project =
    existing ??
    createProject({ projects: p.repo, audit: d.ctx.audit, templates: p.templates }, actor, {
      name: args.name ?? args.repository.split("/")[1]!,
      repository: args.repository,
      prTrigger: "workflow",
      ...(args.slug ? { slug: args.slug } : {}),
    });

  if (project.prTrigger === "webhook")
    return `${args.repository} is project "${project.slug}", which the gangway GitHub App already previews: every pull request gets a preview with no workflow. Nothing to add to the repository.`;

  const port = args.port ?? 3000;
  const lines = [
    `${args.repository} is project "${project.slug}" (${existing ? "already connected" : "created now"}); its pull requests are previewed at ${project.slug}-pr-<n>.`,
  ];
  if (!project.enabled)
    lines.push(
      `It is disabled${project.disabledReason ? `: ${project.disabledReason}` : ""}. The user must enable it in gangway before previews deploy.`,
    );
  lines.push(
    `Commit the file below verbatim at ${WORKFLOW_PATH_IN_REPO} on a branch and open a pull request: that pull request's own run is the first preview, and its URL arrives as a PR comment.`,
    `The workflow builds the Dockerfile at the repository root on GitHub's runners; the image must listen on port ${port}. One image, one port: a compose stack is not supported here.`,
    "Pull requests from forks are skipped. Build-time secrets stay in GitHub (the file shows where); runtime secrets go on the project's Secrets page in gangway.",
    "",
    `--- ${WORKFLOW_PATH_IN_REPO}`,
    workflowFor(project, p.apiOrigin(), port).trimEnd(),
  );
  return lines.join("\n");
}
