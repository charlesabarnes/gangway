// The specs of the tools that set things up rather than deploy: projects, themes and secrets.
import { z } from "zod";
import { ProjectSlugSchema, RepositorySchema } from "@gangway/shared/api";
import {
  THEME_TOKENS,
  ThemeFieldsSchema,
  ThemeFontsSchema,
  ThemeTokensSchema,
} from "@gangway/shared/artifact/theme";
import { THEME_ID } from "@gangway/shared/artifact/vocab";
import { jsonObject, plain, SecretLevel, SecretName } from "./tool-specs.ts";

export const ProjectArgs = z.object({
  repository: RepositorySchema.describe(
    "The GitHub repository, owner/name, e.g. from gh repo view.",
  ),
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe("The port the repository's image listens on, default 3000."),
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe("What gangway calls the project when it is new. Defaults to the repository's name."),
  slug: ProjectSlugSchema.optional().describe(
    "The hostname stem of its previews (<slug>-pr-<n>) when it is new; derived from the name.",
  ),
});
export type ProjectArgs = z.infer<typeof ProjectArgs>;

export const PROJECT_TOOL = {
  title: "Connect a repository for PR previews",
  description:
    "Set up pull-request previews for a GitHub repository: finds or creates its gangway project and returns the GitHub Actions workflow to commit at .github/workflows/gangway-preview.yml. Every pull request then builds the repository's Dockerfile on GitHub's runners and gets a preview URL in a comment. Call it only when the user asks for gangway PR previews on a repository. Needs the projects scope.",
  inputSchema: plain(ProjectArgs),
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export const ThemeArgs = z.object({
  id: z
    .string()
    .regex(THEME_ID, "an id is 1-32 lowercase letters, digits and hyphens")
    .describe(
      "The theme's id, e.g. acme. An existing id is changed; a new one is created. chart is gangway's own and cannot be changed.",
    ),
  name: ThemeFieldsSchema.shape.name
    .optional()
    .describe('What people see it called, e.g. "Acme". Required for a new theme.'),
  description: ThemeFieldsSchema.shape.description.describe(
    'One line on where it comes from, e.g. "From acme.com\'s brand colours".',
  ),
  tokens: z
    .preprocess(jsonObject, ThemeTokensSchema)
    .optional()
    .describe(
      `The kit's colours for light and dark, {light: {...}, dark: {...}}, as #hex, rgb(), hsl() or oklch(). Replaces the theme's tokens, so send every one you set; a token left out falls back to gangway's own. Tokens: ${THEME_TOKENS.join(", ")}.`,
    ),
  fonts: z
    .preprocess(jsonObject, ThemeFontsSchema)
    .optional()
    .describe(
      "The closest of the fonts gangway serves: {serif, sans, mono, titles}. titles is italic-serif, serif or sans.",
    ),
  logo: z
    .string()
    .max(64 * 1024)
    .nullable()
    .optional()
    .describe(
      "An SVG document (<svg …>…</svg>) shown beside titles; scripts and outside links are stripped. null removes it.",
    ),
  makeDefault: z
    .boolean()
    .optional()
    .describe(
      "Make it the server's default for artifacts that name no theme. Only when the user asks: it restyles everyone's artifacts.",
    ),
});
export type ThemeArgs = z.infer<typeof ThemeArgs>;

export const THEME_TOOL = {
  title: "Create or change an artifact theme",
  description:
    "Create or change one of the server's artifact themes: the kit's colours for light and dark, fonts from gangway's list, a title style and a logo. Use it when the user asks for a theme of their own, e.g. from a brand, a website, a stylesheet or a design file. Artifacts pick it with artifact.theme or theme: <id> in artifact.md, and restyle on their next load when it changes. Call with just id to read a theme. Needs the themes scope.",
  inputSchema: plain(ThemeArgs),
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export const SecretsArgs = z.object({
  target: z
    .preprocess(
      jsonObject,
      z.union([
        z.strictObject({ org: z.literal(true) }),
        z.strictObject({ project: z.string().min(1).max(64) }),
        z.strictObject({ preview: z.string().min(1).max(2048) }),
      ]),
    )
    .optional()
    .describe(
      'Where (needed except with upload: "new"): {preview: "<name>"} for one preview (a PR\'s preview keeps them across pushes), {project: "<slug>"} for every preview of a repository, or {org: true} for every preview on the server.',
    ),
  set: z
    .preprocess(
      jsonObject,
      z.record(
        SecretName,
        z.union([z.string(), z.strictObject({ value: z.string(), level: SecretLevel })]),
      ),
    )
    .optional()
    .describe(
      "NAME -> value, or {value, level}. Only values the user typed to you: for a file, use upload so the values never pass through you.",
    ),
  unset: z.array(SecretName).max(100).optional().describe("Names to remove."),
  levels: z
    .preprocess(jsonObject, z.record(SecretName, SecretLevel))
    .optional()
    .describe(
      "Change the level of org or project secrets: a preview gets those at or below its clearance. A preview's own secrets have no level.",
    ),
  upload: z
    .string()
    .max(64)
    .optional()
    .describe(
      'Instead of set, for a .env file: "new" returns a one-use URL and a curl command that sends the file straight to gangway; then call again with upload: "<id>" and the target. Only the names come back.',
    ),
  level: SecretLevel.optional().describe(
    "The level for the uploaded values (org or project; default standard).",
  ),
});
export type SecretsArgs = z.infer<typeof SecretsArgs>;

export const SECRETS_TOOL = {
  title: "Set secrets (write-only)",
  description:
    "Set or remove secrets -- API keys, database URLs, tokens -- for one preview, a project (every preview of a repository) or the whole server. Write-only: it lists names and levels, never values. With no changes it lists the names at the target. Running containers keep the values they started with; the answer says when a change takes effect. For a .env file use upload so the values never pass through you. Needs the secrets scope, narrowed to the previews, projects or org the user chose.",
  inputSchema: plain(SecretsArgs),
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
