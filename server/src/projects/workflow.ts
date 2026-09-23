/**
 * The GitHub Actions workflow a project's repository runs, filled in for that
 * project. Kept as a YAML file beside this one: `${{ }}` is GitHub's syntax, and a JS
 * template literal would try to evaluate it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "@gangway/shared/domain";

const TEMPLATE = readFileSync(join(import.meta.dir, "workflow.template.yaml"), "utf8");

export const WORKFLOW_PATH_IN_REPO = ".github/workflows/gangway-preview.yml";

export function workflowFor(
  project: Pick<Project, "name" | "slug">,
  apiOrigin: string,
  port = 3000,
): string {
  return TEMPLATE.replaceAll("__NAME__", project.name)
    .replaceAll("__API__", apiOrigin)
    .replaceAll("__SLUG__", project.slug)
    .replaceAll("__PORT__", String(port));
}
