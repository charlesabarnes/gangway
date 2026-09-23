import { parseDocument } from "yaml";
import { z } from "zod";
import { parseDuration } from "./duration.ts";
import { ADDON_IDS } from "./addons.ts";
import { RUNTIME_IDS } from "./runtimes.ts";

export const GANGWAY_FILES = ["gangway.yml", "gangway.yaml"] as const;
const MAX_GANGWAY_FILE_BYTES = 64 * 1024;

export const REL_PATH_RE = /^[A-Za-z0-9._@+-][A-Za-z0-9._/@+-]*$/;
export const isRelPath = (p: string): boolean =>
  p.length <= 200 &&
  REL_PATH_RE.test(p) &&
  !p.split("/").some((s) => s === "" || s === "." || s === "..");
const relPath = z
  .string()
  .trim()
  .transform((p) => p.replace(/\/+$/, ""))
  .pipe(
    z
      .string()
      .min(1)
      .refine(
        isRelPath,
        "a relative path inside the upload: letters, digits, . _ - @ + and /, no `..`",
      ),
  );

const command = z.union([
  z.string().trim().min(1).max(8192),
  z
    .array(z.union([z.string(), z.number()]).transform(String).pipe(z.string().max(4096)))
    .min(1)
    .max(64),
]);
export type Command = z.infer<typeof command>;

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const duration = (what: string) =>
  z.string().refine((s) => parseDuration(s) !== null, `expected a duration like ${what}`);

const GangwayFileSchema = z.strictObject({
  $schema: z.string().optional(),
  runtime: z.enum(RUNTIME_IDS).optional(),
  version: z
    .union([z.string(), z.number()])
    .transform(String)
    .pipe(z.string().regex(/^\d+(\.\d+)*$/, 'a version like 22 or "3.13"'))
    .optional(),
  root: relPath.optional(),
  install: z.union([command, z.literal(false)]).optional(),
  build: z.union([command, z.literal(false)]).optional(),
  start: command.optional(),
  release: command.optional(),
  static: z.union([relPath, z.literal(true)]).optional(),
  docroot: relPath.optional(),
  port: z.number().int().min(1).max(65535).optional(),
  healthcheck: z
    .string()
    .regex(/^\/[\x21-\x7e]*$/, "a path starting with /, no spaces")
    .max(200)
    .optional(),
  env: z
    .record(
      z.string().regex(ENV_NAME_RE, "not a valid variable name"),
      z.union([z.string(), z.number(), z.boolean()]).transform(String).pipe(z.string().max(4096)),
    )
    .refine((e) => Object.keys(e).length <= 100, "at most 100 variables")
    .optional(),
  addons: z
    .array(
      z.union([
        z.enum(ADDON_IDS),
        z.strictObject({
          id: z.enum(ADDON_IDS),
          version: z.union([z.string(), z.number()]).transform(String).optional(),
        }),
      ]),
    )
    .max(ADDON_IDS.length)
    .refine(
      (a) => new Set(a.map((x) => (typeof x === "string" ? x : x.id))).size === a.length,
      "each add-on at most once",
    )
    .optional(),
  seed: z.string().min(1).max(8192).optional(),
  ttl: duration("12h or 7d").optional(),
  visibility: z.enum(["public", "unlisted", "private"]).optional(),
  idle: z.union([z.literal("never"), duration("30m")]).optional(),
});
export type GangwayFile = z.infer<typeof GangwayFileSchema>;

export type FileIssue = { path: string; message: string };

export type ParsedGangwayFile =
  { ok: true; file: GangwayFile } | { ok: false; issues: FileIssue[] };

export function parseGangwayFile(text: string): ParsedGangwayFile {
  if (new TextEncoder().encode(text).length > MAX_GANGWAY_FILE_BYTES) {
    return {
      ok: false,
      issues: [
        { path: "", message: `gangway.yml is larger than ${MAX_GANGWAY_FILE_BYTES / 1024} KiB` },
      ],
    };
  }
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length > 0)
    return {
      ok: false,
      issues: doc.errors
        .slice(0, 5)
        .map((e) => ({ path: "", message: e.message.split("\n")[0] ?? "invalid YAML" })),
    };
  let raw: unknown;
  try {
    raw = doc.toJS({ maxAliasCount: 20 }) ?? {};
  } catch (e) {
    return {
      ok: false,
      issues: [{ path: "", message: e instanceof Error ? e.message : "invalid YAML" }],
    };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return {
      ok: false,
      issues: [
        { path: "", message: "gangway.yml must be a mapping of keys, like `start: npm run serve`" },
      ],
    };
  const r = GangwayFileSchema.safeParse(raw);
  if (r.success) return { ok: true, file: r.data };
  return {
    ok: false,
    issues: r.error.issues
      .slice(0, 20)
      .map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
  };
}

export function gangwayJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(GangwayFileSchema, { io: "input", unrepresentable: "any" }),
    title: "gangway.yml",
    description: "How gangway builds and runs an upload that has no compose file.",
  };
}
