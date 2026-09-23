/**
 * `gangway.yml` (ADR-0016): how an upload with no compose file says what the conventions
 * would get wrong -- the command to start it, a build to run first, a directory of built
 * files to serve, a runtime version. Heroku's Procfile and app.json, in one small file.
 *
 * A compose file has `x-gangway` for this; an upload WITH one ignores `gangway.yml`.
 *
 * Every field is optional: an empty file means "the conventions". The schema is strict, so
 * a typo is an error that names the key, not a setting silently ignored. Published as JSON
 * Schema at `GET /v1/schema/gangway.yml` for editors.
 */
import { parseDocument } from "yaml";
import { z } from "zod";
import { parseDuration } from "./duration.ts";
import { ADDON_IDS } from "./addons.ts";
import { RUNTIME_IDS } from "./runtimes.ts";

export const GANGWAY_FILES = ["gangway.yml", "gangway.yaml"] as const;
export const MAX_GANGWAY_FILE_BYTES = 64 * 1024;

/**
 * A path inside the upload, as it lands in a generated file: ordinary path characters only,
 * no `.`/`..`/empty segments. A trailing slash is forgiven.
 */
export const REL_PATH_RE = /^[A-Za-z0-9._@+-][A-Za-z0-9._/@+-]*$/;
export const isRelPath = (p: string): boolean => p.length <= 200 && REL_PATH_RE.test(p) && !p.split("/").some((s) => s === "" || s === "." || s === "..");
const relPath = z.string().trim().transform((p) => p.replace(/\/+$/, ""))
  .pipe(z.string().min(1).refine(isRelPath, "a relative path inside the upload: letters, digits, . _ - @ + and /, no `..`"));

/** A shell command (`npm run build && npm run export`), or an argv run as it is (`[node, server.js]`). */
const command = z.union([
  z.string().trim().min(1).max(8192),
  z.array(z.union([z.string(), z.number()]).transform(String).pipe(z.string().max(4096))).min(1).max(64),
]);
export type Command = z.infer<typeof command>;

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const duration = (what: string) => z.string().refine((s) => parseDuration(s) !== null, `expected a duration like ${what}`);

export const GangwayFileSchema = z.strictObject({
  /** For editors that read it; ignored. */
  $schema: z.string().optional(),
  /** Which runtime builds it. Omitted: detected from the files. */
  runtime: z.enum(RUNTIME_IDS).optional(),
  /** A version the runtime offers (`node: 22`, `python: "3.13"`). Quote it: YAML reads 3.10 as 3.1. */
  version: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d+(\.\d+)*$/, "a version like 22 or \"3.13\"")).optional(),
  /** The app lives in this directory of the upload, not at its root. */
  root: relPath.optional(),
  /** Replaces the install step (`false`: none). */
  install: z.union([command, z.literal(false)]).optional(),
  /** Runs after install (`false`: none, even if package.json has a build script). */
  build: z.union([command, z.literal(false)]).optional(),
  /** What runs the app. It must listen on $PORT, on 0.0.0.0. */
  start: command.optional(),
  /** Runs before each version goes live (migrations): after the build, in a one-off container. */
  release: command.optional(),
  /** Serve built files with nginx instead of running a server: the output directory, or `true` to find dist/, build/ or out/. */
  static: z.union([relPath, z.literal(true)]).optional(),
  /** PHP: the directory Apache serves (`public` for Laravel and Symfony). */
  docroot: relPath.optional(),
  /** The port the app listens on. Needed for an own Dockerfile; a runtime is told its port in $PORT. */
  port: z.number().int().min(1).max(65535).optional(),
  /** A path that answers 2xx/3xx once the app is really up. Omitted: any HTTP answer on `/`. */
  healthcheck: z.string().regex(/^\/[\x21-\x7e]*$/, "a path starting with /, no spaces").max(200).optional(),
  /** Non-secret environment, at build and at run. Secrets belong in the project's secrets, which win. */
  env: z.record(z.string().regex(ENV_NAME_RE, "not a valid variable name"), z.union([z.string(), z.number(), z.boolean()]).transform(String).pipe(z.string().max(4096)))
    .refine((e) => Object.keys(e).length <= 100, "at most 100 variables").optional(),
  /**
   * Throwaway databases beside the app (ADR-0017): `[postgres]`, or `[{ id: postgres, version: 17 }]`.
   * Gone with the preview. `[]` removes them.
   */
  addons: z.array(z.union([
    z.enum(ADDON_IDS),
    z.strictObject({ id: z.enum(ADDON_IDS), version: z.union([z.string(), z.number()]).transform(String).optional() }),
  ])).max(ADDON_IDS.length).refine((a) => new Set(a.map((x) => (typeof x === "string" ? x : x.id))).size === a.length, "each add-on at most once").optional(),
  /** Runs once after the first deploy is healthy (§7.3), in the app's container. */
  seed: z.string().min(1).max(8192).optional(),
  ttl: duration("12h or 7d").optional(),
  visibility: z.enum(["public", "unlisted", "private"]).optional(),
  /** Idle-sleep after this long without a request; `never` opts out. */
  idle: z.union([z.literal("never"), duration("30m")]).optional(),
});
export type GangwayFile = z.infer<typeof GangwayFileSchema>;

/** Where in the file, as a dotted key path (`env.PORT`, `start.1`), and what is wrong there. */
export type FileIssue = { path: string; message: string };

export type ParsedGangwayFile = { ok: true; file: GangwayFile } | { ok: false; issues: FileIssue[] };

export function parseGangwayFile(text: string): ParsedGangwayFile {
  if (new TextEncoder().encode(text).length > MAX_GANGWAY_FILE_BYTES) {
    return { ok: false, issues: [{ path: "", message: `gangway.yml is larger than ${MAX_GANGWAY_FILE_BYTES / 1024} KiB` }] };
  }
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length > 0) return { ok: false, issues: doc.errors.slice(0, 5).map((e) => ({ path: "", message: e.message.split("\n")[0] ?? "invalid YAML" })) };
  let raw: unknown;
  try {
    // A billion-laughs file dies here, not in the planner.
    raw = doc.toJS({ maxAliasCount: 20 }) ?? {};
  } catch (e) {
    return { ok: false, issues: [{ path: "", message: e instanceof Error ? e.message : "invalid YAML" }] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, issues: [{ path: "", message: "gangway.yml must be a mapping of keys, like `start: npm run serve`" }] };
  const r = GangwayFileSchema.safeParse(raw);
  if (r.success) return { ok: true, file: r.data };
  return { ok: false, issues: r.error.issues.slice(0, 20).map((i) => ({ path: i.path.map(String).join("."), message: i.message })) };
}

/** For editors: the file's shape as JSON Schema (draft 2020-12). */
export function gangwayJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(GangwayFileSchema, { io: "input", unrepresentable: "any" }),
    title: "gangway.yml",
    description: "How gangway builds and runs an upload that has no compose file (ADR-0016).",
  };
}
