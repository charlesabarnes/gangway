import type { Project } from "@gangway/shared/domain";
import { can, type Actor } from "../auth/actor.ts";
import { forbidden, notFound, unprocessable } from "../errors.ts";
import { auditFields, createProject } from "../projects/create.ts";
import {
  PUSH_WORKFLOW_PATH_IN_REPO,
  pushWorkflowFor,
  WORKFLOW_PATH_IN_REPO,
  workflowFor,
} from "../projects/workflow.ts";
import type { ToolDeps } from "./tool-deps.ts";
import type { ProjectArgs } from "./setup-tool-specs.ts";

function repoName(repository: string): string {
  const [, name] = repository.split("/");
  if (!name) {
    throw unprocessable("repository: owner/name");
  }
  return name;
}

/** Find or make the repository's workflow project and hand back the file that previews its PRs. */
export function connectProject(d: ToolDeps, actor: Actor, args: ProjectArgs): string {
  const p = d.projects;
  if (!p) {
    throw notFound("projects are not available on this server");
  }
  const existing = p.repo.getByFullName("github", args.repository);
  const project =
    existing ??
    createProject({ projects: p.repo, audit: d.ctx.audit, templates: p.templates }, actor, {
      name: args.name ?? repoName(args.repository),
      repository: args.repository,
      prTrigger: "workflow",
      ...(args.slug ? { slug: args.slug } : {}),
    });

  if (args.branch !== undefined) {
    return deployBranch(d, actor, {
      before: project,
      branch: args.branch,
      existed: existing !== undefined,
    });
  }
  if (project.prTrigger === "webhook") {
    return `${args.repository} is project "${project.slug}", which the gangway GitHub App already previews: every pull request gets a preview with no workflow. Nothing to add to the repository.`;
  }

  const port = args.port ?? 3000;
  const lines = [
    `${args.repository} is project "${project.slug}" (${existing ? "already connected" : "created now"}); its pull requests are previewed at ${project.slug}-pr-<n>.`,
  ];
  if (!project.enabled) {
    const reason = project.disabledReason ? `: ${project.disabledReason}` : "";
    lines.push(
      `It is disabled${reason}. The user must enable it in gangway before previews deploy.`,
    );
  }
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

/** Point the project's push deploys at a branch and hand back the workflow that sends them. */
function deployBranch(
  d: ToolDeps,
  actor: Actor,
  { before, branch, existed }: { before: Project; branch: string; existed: boolean },
): string {
  const p = d.projects;
  if (!p) {
    throw notFound("projects are not available on this server");
  }
  let project = before;
  if (before.deployBranch !== branch) {
    if (!can(actor, "repos.domains")) {
      throw forbidden(
        'choosing the branch a repository deploys as production needs "repos.domains"',
      );
    }
    project = p.repo.update(before.id, { deployBranch: branch }) ?? before;
    d.ctx.audit.record(actor, "project.updated", before.id, {
      old: auditFields(before),
      new: auditFields(project),
    });
  }
  const lines = [
    `${project.fullName ?? project.slug} is project "${project.slug}" (${existed ? "already connected" : "created now"}); every push to ${branch} deploys as its production preview at ${project.slug}.`,
  ];
  if (!project.enabled) {
    const reason = project.disabledReason ? `: ${project.disabledReason}` : "";
    lines.push(`It is disabled${reason}. The user must enable it in gangway before it deploys.`);
  }
  lines.push(
    `Commit the file below verbatim at ${PUSH_WORKFLOW_PATH_IN_REPO} on ${branch}: that push's run is the first deploy.`,
    "The workflow sends the branch's files; gangway builds them as it builds an upload (a compose.yaml, a Dockerfile, or a runtime it detects), so named volumes work. Each push rebuilds in place and keeps the URL, volumes and secrets; a version that fails its checks leaves the previous one serving.",
    "The first push that serves becomes the project's production. Runtime secrets go on the project's Secrets page in gangway.",
    "",
    `--- ${PUSH_WORKFLOW_PATH_IN_REPO}`,
    pushWorkflowFor({ ...project, deployBranch: branch }, p.apiOrigin()).trimEnd(),
  );
  return lines.join("\n");
}
