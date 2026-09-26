import { z } from "zod";
import { ARTIFACT_KINDS, TemplateInputSchema } from "@gangway/shared/artifact/index";
import {
  THEME_TOKENS,
  ThemeFieldsSchema,
  ThemeFontsSchema,
  ThemeTokensSchema,
} from "@gangway/shared/artifact/theme";
import { THEME_ID } from "@gangway/shared/artifact/vocab";
import { ProjectSlugSchema, RepositorySchema, VISIBILITY_VALUES } from "@gangway/shared/api";
import { PREVIEW_ICON_COLORS, PREVIEW_ICONS } from "@gangway/shared/preview-icon";
import { CHECK_PATH } from "../previews/probe.ts";

export const DEFAULT_WAIT_S = 240;
const MAX_WAIT_S = 600;
const MAX_CHECKS = 20;

type Json = { [k: string]: unknown };

function simplify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(simplify);
  if (!node || typeof node !== "object") return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "$schema" || k === "propertyNames") continue;
    if (k === "type" && Array.isArray(v)) continue;
    out[k] = simplify(v);
  }
  return out;
}

/**
 * ChatGPT fails on schemas other clients accept, so tools publish plain JSON Schema: no $schema,
 * propertyNames or type lists. Arguments are still checked against the full zod schema.
 */
function plain<S extends z.ZodType>(schema: S): S {
  const std = schema["~standard"];
  const input = () => simplify(z.toJSONSchema(schema, { io: "input" })) as Json;
  const output = () => simplify(z.toJSONSchema(schema, { io: "output" })) as Json;
  return Object.assign(Object.create(schema) as S, {
    "~standard": { ...std, jsonSchema: { input, output } },
  });
}

// Some clients send a nested object as its JSON text.
function jsonObject(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

export const DeployArgs = z.object({
  artifact: z
    .preprocess(jsonObject, TemplateInputSchema)
    .optional()
    .describe(
      'Build an artifact from a template instead of writing files: {template: "deck/pitch", title, subtitle, mode, theme, accent, options}. The catalog tool lists the templates and their options. Change it afterwards with preview + files; preview + artifact rebuilds it from a template at the same URL.',
    ),
  files: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'The app as text files, path -> contents, e.g. {"index.html": "<h1>hi</h1>"}. A runtime is picked from what is there (static, node, bun, deno, python, php; a Dockerfile or compose.yaml is used as-is). Up to 1000 files, 2 MiB.',
    ),
  image: z
    .string()
    .optional()
    .describe("Instead of files: a public container image, e.g. traefik/whoami:v1.10. Needs port."),
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe("The port the image listens on inside the container."),
  git: z
    .object({
      repo: z.string().describe("An https URL on github.com"),
      ref: z.string().describe("A branch, tag or commit"),
    })
    .optional()
    .describe("Instead of files: a git repository to clone and build."),
  upload: z
    .string()
    .max(64)
    .optional()
    .describe(
      'Instead of files, for anything bigger than a page or two: "new" returns a one-use URL to PUT a .tar.gz of the app to (with curl) -- nothing is deployed yet. Then call deploy again with upload: "<the id>" and the usual options. Faster than files, and deploys exactly the bytes on disk.',
    ),
  preview: z
    .string()
    .optional()
    .describe(
      "Rebuild THIS existing preview (its name, URL or id) at the same URL. files are then changes: only the files named are written. With upload: the whole source is replaced by the upload.",
    ),
  remove: z.array(z.string()).optional().describe("With preview: paths to delete."),
  name: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe(
      "The first label of the hostname. Defaults to one derived from the title, else the source.",
    ),
  title: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Always set one: what people see it called in gangway\'s list, e.g. "Checkout redesign" or "Q3 board deck". With preview, renames it without a rebuild.',
    ),
  icon: z
    .enum(PREVIEW_ICONS)
    .optional()
    .describe(
      "Always set one: the icon beside the title in gangway's list. Pick what it is about, not how it is built: presentation for a deck, chart-line for metrics, shopping-cart for a shop. With preview, changes it without a rebuild.",
    ),
  iconColor: z
    .enum(PREVIEW_ICON_COLORS)
    .optional()
    .describe(
      "The icon's colour (default navy). Match an artifact's accent, or pick one that tells it apart from the user's other previews.",
    ),
  visibility: z
    .enum(VISIBILITY_VALUES)
    .optional()
    .describe(
      "Leave it out unless the user asks: the server's setting decides. public; unlisted (an unguessable hostname); private (visitors must log in).",
    ),
  ttl: z
    .string()
    .max(16)
    .optional()
    .describe("How long it lives, e.g. 2h or 7d. Defaults to the server's."),
  template: z
    .string()
    .optional()
    .describe(
      "A named preview policy on the server (visibility, ttl, host). Not an artifact template: those go in artifact.template.",
    ),
  project: z.string().optional().describe("A project slug to file the preview under."),
  passwordLogin: z
    .enum(["inherit", "on", "off", "only"])
    .optional()
    .describe(
      "Who can open it. off: anyone with the password; on: people signed in to gangway, or anyone with the password; only: only people signed in to gangway (no password); inherit follows the server.",
    ),
  password: z
    .enum(["inherit", "none", "generate"])
    .optional()
    .describe(
      "Put it behind a password: generate makes one and prints it ONLY in the preview's log (read it with logs); none leaves it open; inherit (the default) follows the server's setting.",
    ),
  network: z
    .enum(["auto", "shared", "isolated"])
    .optional()
    .describe(
      "auto (default): one service joins the shared preview network; add-ons or several services get their own. shared or isolated to choose.",
    ),
  watermark: z
    .enum(["inherit", "on", "off"])
    .optional()
    .describe(
      "The gangway watermark in the bottom-right corner of every page: inherit (the repository's, then the server's setting), on or off. With preview, it changes with no rebuild.",
    ),
  addons: z
    .array(z.string())
    .optional()
    .describe(
      'Throwaway databases, e.g. ["postgres"], ["redis@8"]. Their URLs arrive as env vars (DATABASE_URL, REDIS_URL).',
    ),
  idempotencyKey: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Retry with the same key and you get the same preview, not a second one. Omitted, an identical request counts as a retry.",
    ),
  waitSeconds: z
    .number()
    .int()
    .min(0)
    .max(MAX_WAIT_S)
    .optional()
    .describe(
      `How long to wait for the URL to answer, default ${DEFAULT_WAIT_S}. 0 returns at once.`,
    ),
  check: z
    .array(z.string().regex(CHECK_PATH, "a path starting with /, no spaces"))
    .max(MAX_CHECKS)
    .optional()
    .describe(
      'Paths to GET once it answers, e.g. ["/", "/api/health"]. Each one\'s status comes back with the result, so you need not curl them.',
    ),
});
export type DeployArgs = z.infer<typeof DeployArgs>;

const PreviewRef = z.string().min(1).max(2048);
const LOG_SOURCES = ["all", "pipeline", "runtime"] as const;
export type LogSource = (typeof LOG_SOURCES)[number];

export const GENERATE_ARTIFACT_PROMPT = {
  title: "Build and ship an artifact",
  description:
    "Build a chart, diagram, document, slide deck or canvas from gangway's templates (or, when those can't express it, a small app) and ship it to a real URL here, the fast way.",
  argsSchema: z.object({ what: z.string().max(2000).optional().describe("What to build") }),
};

export const DEPLOY_TOOL = {
  title: "Deploy a preview",
  description:
    "Put an artifact or an app on a real HTTPS URL on the user's gangway server, in about 10 seconds: an artifact from a template (artifact: {template, …}; call catalog first), text files, an upload, a container image, or a git repository. Use it for anything you would make as an artifact, and for a new app or a one-off once it runs (offer the URL first unless the user asked to put it up); leave a repo's own deploy setup alone. Waits until the URL answers and returns it. Also rebuilds an existing preview in place (preview + files). Give every preview a title and an icon: they are how the user finds it.",
  inputSchema: plain(DeployArgs),
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

export const STATUS_TOOL = {
  title: "Preview status",
  description:
    "One preview's state, URL and expiry (by name, URL or id), or every live preview when none is named.",
  inputSchema: plain(
    z.object({
      preview: PreviewRef.optional().describe("A name, URL or id. Omit to list them all."),
    }),
  ),
  annotations: { readOnlyHint: true },
};

export const LOGS_TOOL = {
  title: "Preview logs",
  description:
    "A preview's logs: the pipeline (build, start, gangway's own lines) and the runtime (what its containers print, e.g. your server's startup line and its errors). Read this when a deploy failed or the app misbehaves.",
  inputSchema: plain(
    z.object({
      preview: PreviewRef,
      lines: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("How many per section, default 80."),
      source: z.enum(LOG_SOURCES).optional().describe("pipeline, runtime, or all (the default)."),
      service: z
        .string()
        .max(63)
        .optional()
        .describe("Runtime lines of one service only, e.g. web or postgres."),
    }),
  ),
  annotations: { readOnlyHint: true },
};

export const DESTROY_TOOL = {
  title: "Destroy a preview",
  description:
    "Tear a preview down: its URL stops answering and its containers and data are removed.",
  inputSchema: plain(z.object({ preview: PreviewRef })),
  annotations: { destructiveHint: true, idempotentHint: true },
};

export const CATALOG_TOOL = {
  title: "Artifact templates and components",
  description:
    "Call this first whenever you would draw a chart or a diagram, or make an artifact: a report, a memo, release notes, a process, a slide deck, a flow of screens, a board or a system map. gangway builds it at a real URL in place of the host's own artifacts or a local HTML file. Returns the artifact.md guide (markdown plus blocks, charts, flowcharts and slides), that kind's templates with their options, and a complete example. Read it before writing artifact.md or deploying an artifact.",
  inputSchema: plain(
    z.object({
      kind: z
        .enum(ARTIFACT_KINDS)
        .describe(
          "document: to read, with numbers, charts and diagrams (a report, memo, release notes, a process). deck: a talk or a pitch. canvas: a board of frames to pan and zoom (a system's architecture, screens of a flow, illustrations).",
        ),
      template: z
        .string()
        .max(64)
        .optional()
        .describe("A template id from the list, e.g. deck/status: returns its files to adapt."),
    }),
  ),
  annotations: { readOnlyHint: true },
};

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
