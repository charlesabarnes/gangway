import { z } from "zod";
import { ARTIFACT_KINDS, TemplateInputSchema } from "@gangway/shared/artifact/index";
import { VISIBILITY_VALUES } from "@gangway/shared/api";
import { PREVIEW_ICON_COLORS, PREVIEW_ICONS } from "@gangway/shared/preview-icon";
import { CHECK_PATH } from "../previews/probe.ts";

export const DEFAULT_WAIT_S = 240;
const MAX_WAIT_S = 600;
const MAX_CHECKS = 20;

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
      'Build an artifact from a template instead of writing files: {template: "deck/pitch", title, subtitle, theme, accent, options}. The catalog tool lists the templates and their options. Change it afterwards with preview + files; preview + artifact rebuilds it from a template at the same URL.',
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
    .describe("public; unlisted (an unguessable hostname); private (visitors must log in)."),
  ttl: z
    .string()
    .max(16)
    .optional()
    .describe("How long it lives, e.g. 2h or 7d. Defaults to the server's."),
  template: z.string().optional().describe("A named server policy (visibility, ttl, host)."),
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
  brand: z
    .enum(["inherit", "on", "off"])
    .optional()
    .describe(
      "Show the faint gangway mark on an artifact: inherit (the server's setting), on or off.",
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
    "Build a document, dashboard, slide deck or clickable prototype from gangway's templates (or, when those can't express it, a small app) and ship it to a real URL here, the fast way.",
  argsSchema: z.object({ what: z.string().max(2000).optional().describe("What to build") }),
};

export const DEPLOY_TOOL = {
  title: "Deploy a preview",
  description:
    "Put an artifact or an app on a public HTTPS URL: an artifact from a template (artifact: {template, …}; see the catalog tool), text files, an upload, a container image, or a git repository. Waits until the URL answers and returns it. Also rebuilds an existing preview in place (preview + files). Give every preview a title and an icon: they are how the user finds it.",
  inputSchema: DeployArgs,
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

export const STATUS_TOOL = {
  title: "Preview status",
  description:
    "One preview's state, URL and expiry (by name, URL or id), or every live preview when none is named.",
  inputSchema: z.object({
    preview: PreviewRef.optional().describe("A name, URL or id. Omit to list them all."),
  }),
  annotations: { readOnlyHint: true },
};

export const LOGS_TOOL = {
  title: "Preview logs",
  description:
    "A preview's logs: the pipeline (build, start, gangway's own lines) and the runtime (what its containers print, e.g. your server's startup line and its errors). Read this when a deploy failed or the app misbehaves.",
  inputSchema: z.object({
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
  annotations: { readOnlyHint: true },
};

export const DESTROY_TOOL = {
  title: "Destroy a preview",
  description:
    "Tear a preview down: its URL stops answering and its containers and data are removed.",
  inputSchema: z.object({ preview: PreviewRef }),
  annotations: { destructiveHint: true, idempotentHint: true },
};

export const CATALOG_TOOL = {
  title: "Artifact templates and components",
  description:
    "Start here for a document, dashboard, slide deck or clickable prototype. Returns the artifact.md guide (markdown plus a few blocks, charts and slides), that kind's templates with their options, and a complete example. Read it before writing artifact.md or deploying an artifact.",
  inputSchema: z.object({
    kind: z.enum(ARTIFACT_KINDS).describe("What you are making."),
    template: z
      .string()
      .max(64)
      .optional()
      .describe("A template id from the list, e.g. deck/status: returns its files to adapt."),
  }),
  annotations: { readOnlyHint: true },
};
