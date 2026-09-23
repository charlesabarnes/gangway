/**
 * Request schemas for the public API. ADR-0003: the REST handler, the webhook receiver
 * and the MCP `deploy` tool all validate with THESE, so there is one definition of what a
 * deploy request is, shared with the Angular client for free.
 */
import { z } from "zod";
import { ALL_PERMISSIONS, SCOPES, isPermission, type Permission } from "./permissions.ts";
import { RUNTIME_IDS } from "./runtimes.ts";
import { ADDON_IDS, isAddonId } from "./addons.ts";

/** Runtime copies of the domain's string unions, so the web contract test has something to compare. */
export const PREVIEW_STATE_VALUES = [
  "building",
  "starting",
  "awake",
  "asleep",
  "failed",
  "destroying",
  "destroyed",
] as const;
export const VISIBILITY_VALUES = ["public", "unlisted", "private"] as const;

/** A Docker image reference. Conservative on purpose: it becomes an argument to a CLI. */
const imageRef = z
  .string()
  .max(255)
  .regex(/^[a-z0-9][a-z0-9._/:@-]*$/i, "not a valid image reference");

const envMap = z
  .record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "not a valid environment variable name"),
    z.string().max(32_768),
  )
  .refine((e) => Object.keys(e).length <= 100, "at most 100 variables");

const containerPort = z.number().int().min(1).max(65535);

export const DeploySourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("image"),
    image: imageRef,
    /** The port the app listens on INSIDE the container. */
    port: z.number().int().min(1).max(65535),
    env: envMap.optional(),
  }),
  z.strictObject({
    kind: z.literal("git"),
    /** An absolute https URL. Which hosts are allowed is the server's decision, not the schema's. */
    repo: z.string().url().max(2_048),
    ref: z.string().min(1).max(255),
    /** Only for a repo with a Dockerfile and no compose file. */
    port: containerPort.optional(),
  }),
]);

const templateId = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/,
    "a template id is 1-32 lowercase letters, digits and hyphens",
  );

/** ADR-0017: an add-on by id, optionally at a major version. */
const addonRequest = z.union([
  z.enum(ADDON_IDS),
  z.strictObject({
    id: z.enum(ADDON_IDS),
    version: z
      .string()
      .regex(/^\d+(\.\d+)*$/)
      .max(16)
      .optional(),
  }),
]);
const addonArray = z
  .array(addonRequest)
  .max(ADDON_IDS.length)
  .refine(
    (a) => new Set(a.map((x) => (typeof x === "string" ? x : x.id))).size === a.length,
    "each add-on at most once",
  );

/** `?addons=postgres,redis@8` in a query string; `none` for no add-ons. */
export const addonQuery = z
  .string()
  .max(200)
  .transform((s, ctx) => {
    const out: z.input<typeof addonArray> = [];
    if (s === "none" || s === "") return out;
    for (const part of s.split(",")) {
      const [id, version] = part.trim().split("@") as [string, string | undefined];
      if (!isAddonId(id) || (version !== undefined && !/^\d+(\.\d+)*$/.test(version))) {
        ctx.addIssue({
          code: "custom",
          message: `unknown add-on ${JSON.stringify(part)}: one of ${ADDON_IDS.join(", ")}, optionally @<major>`,
        });
        return z.NEVER;
      }
      out.push(version ? { id, version } : { id });
    }
    return out;
  })
  .pipe(addonArray);

/**
 * A tarball deploy has no JSON body -- the body IS the archive -- so its options ride in
 * the query string:  curl --data-binary @src.tgz -H 'content-type: application/gzip' '.../v1/previews?name=x'
 */
export const TarballDeployQuerySchema = z.object({
  name: z.string().min(1).max(40).optional(),
  visibility: z.enum(VISIBILITY_VALUES).optional(),
  /** `12h`, `7d`, or `none` for no expiry. */
  ttl: z.string().max(16).optional(),
  hostId: z.string().min(1).max(64).optional(),
  template: templateId.optional(),
  project: z.string().min(1).max(64).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  /** ADR-0015: build with a runtime, `auto` to detect one; absent or `own`, the upload's own stack. */
  runtime: z.enum([...RUNTIME_IDS, "auto", "own"]).optional(),
  /** ADR-0017: throwaway databases, `postgres,redis`. Absent: gangway.yml's, if any. */
  addons: addonQuery.optional(),
  /** ADR-0023: `inherit`, `none` or `generate`. A chosen password rides in PREVIEW_PASSWORD_HEADER. */
  password: z.enum(["inherit", "none", "generate"]).optional(),
  passwordLogin: z.enum(["inherit", "on", "off", "only"]).optional(),
});

const runtimeChoice = z.enum([...RUNTIME_IDS, "auto", "own"]);

/** `PUT /v1/previews/:id/source`: the body is the new upload; the runtime rides in the query. */
export const SourceReplaceQuerySchema = z.object({
  runtime: runtimeChoice.optional(),
  addons: addonQuery.optional(),
});

/** `PATCH /v1/previews/:id/source` (ADR-0015): each path's new text, or null to delete it. */
export const SourceEditSchema = z
  .strictObject({
    files: z
      .record(
        z.string().min(1).max(255),
        z
          .string()
          .max(1024 * 1024)
          .nullable(),
      )
      .refine((f) => Object.keys(f).length <= 500, "at most 500 files per edit"),
    runtime: runtimeChoice.optional(),
    /** ADR-0017. Omitted: as gangway.yml says, else as before. `[]` removes them. */
    addons: addonArray.optional(),
  })
  .refine(
    (e) => Object.keys(e.files).length > 0 || e.runtime !== undefined || e.addons !== undefined,
    "nothing to change",
  );
export type SourceEdit = z.infer<typeof SourceEditSchema>;

/**
 * `POST /v1/runtimes/plan` (ADR-0016): what the server WOULD do with these files, asked
 * before uploading them. `files` holds the contents of the few files the plan reads
 * (`planFiles` in `GET /v1/runtimes`); the rest are only named.
 */
export const PlanRequestSchema = z.strictObject({
  paths: z.array(z.string().min(1).max(255)).max(20_000),
  files: z
    .record(z.string().min(1).max(255), z.string().max(256 * 1024))
    .refine((f) => Object.keys(f).length <= 64, "at most 64 files")
    .refine(
      (f) => Object.values(f).reduce((n, t) => n + t.length, 0) <= 1024 * 1024,
      "at most 1 MiB of file contents",
    )
    .default({}),
  runtime: runtimeChoice.optional(),
  addons: addonArray.optional(),
});
export type PlanRequest = z.infer<typeof PlanRequestSchema>;
export const TARBALL_CONTENT_TYPES = [
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/octet-stream",
] as const;

/**
 * ADR-0023: a preview's password. `inherit` (the default) follows Settings; `none` opens it;
 * `set` takes a value; `generate` has gangway make one and print it in the preview's log.
 */
/** Any length the person wants; the cap only keeps a huge body out of the proxy (the gate reads at most 1024). */
export const PREVIEW_PASSWORD_MAX = 1024;
export const PasswordChoiceSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("inherit") }),
  z.strictObject({ mode: z.literal("none") }),
  z.strictObject({ mode: z.literal("generate") }),
  z.strictObject({
    mode: z.literal("set"),
    value: z.string().min(1, "a password cannot be empty").max(PREVIEW_PASSWORD_MAX),
  }),
]);
export type PasswordChoice = z.infer<typeof PasswordChoiceSchema>;

export const PasswordLoginSchema = z.enum(["inherit", "on", "off", "only"]);

/**
 * `PUT /v1/previews/:id/password`: the password, whether a gangway login gets past it, or
 * both. What is left out is kept.
 */
export const PreviewPasswordChangeSchema = z
  .strictObject({
    password: PasswordChoiceSchema.optional(),
    login: PasswordLoginSchema.optional(),
  })
  .refine(
    (b) => b.password !== undefined || b.login !== undefined,
    "nothing to change: send password, login or both",
  );

/**
 * `PUT /v1/settings/preview-password`: the server-wide default. `shared` needs a value unless
 * one is already set. `login`: whether a signed-in gangway user skips the password on
 * previews that follow the default; omitted, unchanged.
 */
export const DefaultPasswordSchema = z.strictObject({
  login: z.boolean().optional(),
  mode: z.enum(["off", "shared", "generated"]),
  value: z.string().min(1, "a password cannot be empty").max(PREVIEW_PASSWORD_MAX).optional(),
});

/**
 * A tarball deploy carries a CHOSEN password in the `gangway-preview-password` header, never
 * the query string (query strings end up in logs); the query names the other modes.
 */
export const PREVIEW_PASSWORD_HEADER = "gangway-preview-password";

export const DeployRequestSchema = z.strictObject({
  source: DeploySourceSchema,
  name: z.string().min(1).max(40).optional(),
  visibility: z.enum(VISIBILITY_VALUES).optional(),
  /** `12h`, `7d`; null for no expiry. Omitted means the server default. */
  ttl: z.string().max(16).nullable().optional(),
  hostId: z.string().min(1).max(64).optional(),
  /** A template by id (ADR-0013). Omitted: the project's, else the trigger's default. */
  template: templateId.optional(),
  /** A project by id or slug (ADR-0014): the preview is filed under it and follows its policy. */
  project: z.string().min(1).max(64).optional(),
  /** ADR-0023. Omitted: inherit the server-wide default. */
  password: PasswordChoiceSchema.optional(),
  /** ADR-0023: whether a gangway login gets past the password. Omitted: the server default. */
  passwordLogin: PasswordLoginSchema.optional(),
});
export type DeployRequest = z.infer<typeof DeployRequestSchema>;

const previewState = z.enum(PREVIEW_STATE_VALUES);

export const PreviewListQuerySchema = z.object({
  /** Repeatable (`?state=awake&state=asleep`) or comma-joined. Naming `destroyed` includes it. */
  state: z.array(previewState).max(7).optional(),
  hostId: z.string().optional(),
  /** Destroyed previews are left out unless asked for. */
  includeDestroyed: z.enum(["true", "false"]).optional(),
});

export const PreviewLogsQuerySchema = z.object({
  /** Start from only the last N lines. The stream says so when it skipped any. */
  tail: z.coerce.number().int().min(1).max(5_000).optional(),
});

/* ------------------------------------------------------------------ accounts (§8) */

/** Lowercased here because `users.email` is UNIQUE without NOCASE: Ada@ and ada@ are one person. */
const email = z.string().trim().toLowerCase().pipe(z.string().email().max(254));

/**
 * Length is the only rule (NIST 800-63B): composition rules make passwords worse. The cap
 * is not about strength -- scrypt is CPU-bound and the input is attacker-supplied.
 */
const password = z.string().min(12, "at least 12 characters").max(256);

export const LoginRequestSchema = z.strictObject({
  email,
  /** NOT the `password` schema: a login must never reveal the rules by failing validation. */
  password: z.string().min(1).max(1024),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const SetupRequestSchema = z.strictObject({
  token: z.string().min(1).max(256),
  email,
  password,
});
export type SetupRequest = z.infer<typeof SetupRequestSchema>;

const roleId = z.string().min(1).max(64);

export const CreateUserSchema = z.strictObject({ email, password, roleId });
export type CreateUserRequest = z.infer<typeof CreateUserSchema>;

export const UpdateUserSchema = z
  .strictObject({
    roleId: roleId.optional(),
    disabled: z.boolean().optional(),
    /** An admin reset. Ends every session the account has. */
    password: password.optional(),
  })
  .refine((u) => Object.keys(u).length > 0, "nothing to change");
export type UpdateUserRequest = z.infer<typeof UpdateUserSchema>;

export const ChangePasswordSchema = z.strictObject({
  current: z.string().min(1).max(1024),
  next: password,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordSchema>;

export const CreateTokenSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(SCOPES)).min(1).max(SCOPES.length),
  /** A duration like `90d`. Omitted: the token does not expire. */
  expiresIn: z.string().max(16).optional(),
});
export type CreateTokenRequest = z.infer<typeof CreateTokenSchema>;

/** The COMPLETE set a role should hold afterwards -- a PUT, not a patch. */
export const SetRolePermissionsSchema = z.strictObject({
  permissions: z
    .array(z.string().refine((s): s is Permission => isPermission(s), "not a known permission"))
    .max(ALL_PERMISSIONS.length),
});
export type SetRolePermissionsRequest = z.infer<typeof SetRolePermissionsSchema>;

/** `PUT /v1/settings`: a partial map of key -> value. Each value is checked against its own schema. */
export const SetSettingsSchema = z.strictObject({
  values: z
    .record(z.string().min(1).max(64), z.unknown())
    .refine((v) => Object.keys(v).length > 0, "no settings given"),
});
export type SetSettingsRequest = z.infer<typeof SetSettingsSchema>;

/**
 * `PUT /v1/surfaces` (§10.5). Turning the UI off is the one-way door, so it carries a typed
 * phrase the SERVER checks: the ceremony is not a client-side courtesy.
 */
export const DISABLE_UI_PHRASE = "disable the UI";
export const SetSurfacesSchema = z
  .strictObject({
    ui: z.boolean().optional(),
    mcp: z.boolean().optional(),
    confirm: z.string().max(100).optional(),
  })
  .refine((v) => v.ui !== undefined || v.mcp !== undefined, "name ui, mcp, or both");
export type SetSurfacesRequest = z.infer<typeof SetSurfacesSchema>;

/** `POST /v1/github/manifest/exchange`: what GitHub sent the browser back with. */
export const ManifestExchangeSchema = z.strictObject({
  code: z.string().min(1).max(200),
  state: z.string().min(1).max(200),
});
export type ManifestExchangeRequest = z.infer<typeof ManifestExchangeSchema>;

/** `PATCH /v1/repos/:id`: the per-repository knobs (ADR-0011). */
const projectSlug = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/,
    "a slug is 1-24 lowercase letters, digits and hyphens",
  );
/** `owner/name`, as GitHub spells it. */
const repository = z
  .string()
  .trim()
  .regex(/^[\w.-]+\/[\w.-]+$/, "a repository is owner/name");
const prTrigger = z.enum(["workflow", "webhook"]);

/** `POST /v1/projects` (ADR-0014). A project is made on purpose; the slug defaults from the name. */
export const ProjectCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(64),
  slug: projectSlug.optional(),
  /** Omitted: a project with no repository, for images and tarballs. */
  repository: repository.optional(),
  prTrigger: prTrigger.optional(),
  templateId: z.string().min(1).max(32).nullable().optional(),
});
export type ProjectCreateRequest = z.infer<typeof ProjectCreateSchema>;

/**
 * `PUT /v1/projects/:ref/pulls/:n` (ADR-0014): the image a workflow pushed for the PR's
 * head. `registry` logs in for this one pull and is never stored.
 */
export const PullDeploySchema = z.strictObject({
  image: z
    .string()
    .min(3)
    .max(512)
    .regex(/^[a-z0-9][a-z0-9._/:@-]*$/i, "not an image reference"),
  port: z.number().int().min(1).max(65535),
  sha: z.string().regex(/^[0-9a-f]{7,64}$/, "a commit sha"),
  registry: z
    .strictObject({ username: z.string().min(1).max(256), password: z.string().min(1).max(4096) })
    .optional(),
});
export type PullDeployRequestBody = z.infer<typeof PullDeploySchema>;

export const ProjectPatchSchema = z.strictObject({
  name: z.string().trim().min(1).max(64).optional(),
  /** null: no repository any more. */
  repository: repository.nullable().optional(),
  prTrigger: prTrigger.optional(),
  slug: projectSlug.optional(),
  enabled: z.boolean().optional(),
  visibility: z.enum(["public", "unlisted", "private"]).nullable().optional(),
  ttl: z.string().max(16).nullable().optional(),
  forks: z.enum(["ask", "auto", "never"]).optional(),
  drafts: z.boolean().optional(),
  templateId: templateId.nullable().optional(),
  prClearance: z.enum(["none", "low", "standard", "high"]).nullable().optional(),
  forkClearance: z.enum(["none", "low", "standard", "high"]).optional(),
});
export type ProjectPatchRequest = z.infer<typeof ProjectPatchSchema>;

/* ------------------------------------------------------------------ templates (ADR-0013) */

const templateFields = {
  name: z.string().trim().min(1).max(64),
  description: z.string().max(500),
  visibility: z.enum(VISIBILITY_VALUES),
  /** A duration, or null for no expiry. */
  ttl: z.string().max(16).nullable(),
  /** A duration, or `never`. */
  idleAfter: z.string().max(16),
  clearance: z.enum(["none", "low", "standard", "high"]),
  hostId: z.string().min(1).max(64).nullable(),
};
export const TemplateCreateSchema = z.strictObject({
  id: templateId,
  name: templateFields.name,
  description: templateFields.description.optional(),
  visibility: templateFields.visibility.optional(),
  ttl: templateFields.ttl.optional(),
  idleAfter: templateFields.idleAfter.optional(),
  clearance: templateFields.clearance.optional(),
  hostId: templateFields.hostId.optional(),
});
export type TemplateCreateRequest = z.infer<typeof TemplateCreateSchema>;
export const TemplatePatchSchema = z.strictObject(
  Object.fromEntries(Object.entries(templateFields).map(([k, v]) => [k, v.optional()])) as {
    [K in keyof typeof templateFields]: z.ZodOptional<(typeof templateFields)[K]>;
  },
);
export type TemplatePatchRequest = z.infer<typeof TemplatePatchSchema>;

/** `PATCH /v1/repos/:id/env`: merge secrets in, take names out. Values are never returned. */
const secretLevel = z.enum(["low", "standard", "high"]);
export const EnvPatchSchema = z
  .strictObject({
    set: z
      .record(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "not a valid variable name"),
        z.union([z.string(), z.strictObject({ value: z.string(), level: secretLevel })]),
      )
      .optional(),
    unset: z.array(z.string()).max(100).optional(),
    levels: z.record(z.string(), secretLevel).optional(),
  })
  .refine(
    (v) =>
      Object.keys(v.set ?? {}).length > 0 ||
      (v.unset ?? []).length > 0 ||
      Object.keys(v.levels ?? {}).length > 0,
    "nothing to change",
  );
export type EnvPatchRequest = z.infer<typeof EnvPatchSchema>;

export const AuditQuerySchema = z.object({
  /** Entries with a seq BELOW this one: the log is read newest-first. */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  action: z.string().max(64).optional(),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;
