import { z } from "zod";
import { ALL_PERMISSIONS, SCOPES, isPermission, type Permission } from "./permissions.ts";
import { RUNTIME_IDS } from "./runtimes.ts";
import { ADDON_IDS, isAddonId } from "./addons.ts";
import { WATERMARK_CHOICES, NETWORK_CHOICES } from "./domain.ts";
import { PREVIEW_ICON_COLORS, PREVIEW_ICONS, PreviewIconSchema } from "./preview-icon.ts";
import { DomainNameSchema } from "./domains-api.ts";

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

// Conservative on purpose: it becomes a CLI argument.
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

const DeploySourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("image"),
    image: imageRef,
    port: z.number().int().min(1).max(65535),
    env: envMap.optional(),
  }),
  z.strictObject({
    kind: z.literal("git"),
    repo: z.string().url().max(2_048),
    ref: z.string().min(1).max(255),
    port: containerPort.optional(),
  }),
]);

const templateId = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/,
    "a template id is 1-32 lowercase letters, digits and hyphens",
  );

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

export const PREVIEW_TITLE_MAX = 100;
const previewTitle = z.string().trim().min(1, "a title cannot be empty").max(PREVIEW_TITLE_MAX);

export const TarballDeployQuerySchema = z.object({
  name: z.string().min(1).max(40).optional(),
  title: previewTitle.optional(),
  icon: z.enum(PREVIEW_ICONS).optional(),
  iconColor: z.enum(PREVIEW_ICON_COLORS).optional(),
  visibility: z.enum(VISIBILITY_VALUES).optional(),
  ttl: z.string().max(16).optional(),
  hostId: z.string().min(1).max(64).optional(),
  template: templateId.optional(),
  project: z.string().min(1).max(64).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  runtime: z.enum([...RUNTIME_IDS, "auto", "own"]).optional(),
  addons: addonQuery.optional(),
  password: z.enum(["inherit", "none", "generate"]).optional(),
  passwordLogin: z.enum(["inherit", "on", "off", "only"]).optional(),
  network: z.enum(NETWORK_CHOICES).optional(),
  watermark: z.enum(WATERMARK_CHOICES).optional(),
  domain: DomainNameSchema.optional(),
  /** The old name for watermark. */
  brand: z.enum(WATERMARK_CHOICES).optional(),
});

const runtimeChoice = z.enum([...RUNTIME_IDS, "auto", "own"]);

export const SourceReplaceQuerySchema = z.object({
  runtime: runtimeChoice.optional(),
  addons: addonQuery.optional(),
  network: z.enum(NETWORK_CHOICES).optional(),
});

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
    addons: addonArray.optional(),
    network: z.enum(NETWORK_CHOICES).optional(),
  })
  .refine(
    (e) =>
      Object.keys(e.files).length > 0 ||
      e.runtime !== undefined ||
      e.addons !== undefined ||
      e.network !== undefined,
    "nothing to change",
  );
export type SourceEdit = z.infer<typeof SourceEditSchema>;

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

export const PREVIEW_PASSWORD_MAX = 1024;
const PasswordChoiceSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("inherit") }),
  z.strictObject({ mode: z.literal("none") }),
  z.strictObject({ mode: z.literal("generate") }),
  z.strictObject({
    mode: z.literal("set"),
    value: z.string().min(1, "a password cannot be empty").max(PREVIEW_PASSWORD_MAX),
  }),
]);
export type PasswordChoice = z.infer<typeof PasswordChoiceSchema>;

const PasswordLoginSchema = z.enum(["inherit", "on", "off", "only"]);

export const PreviewPasswordChangeSchema = z
  .strictObject({
    password: PasswordChoiceSchema.optional(),
    login: PasswordLoginSchema.optional(),
  })
  .refine(
    (b) => b.password !== undefined || b.login !== undefined,
    "nothing to change: send password, login or both",
  );

export const DefaultPasswordSchema = z.strictObject({
  login: z.boolean().optional(),
  mode: z.enum(["off", "shared", "generated"]),
  value: z.string().min(1, "a password cannot be empty").max(PREVIEW_PASSWORD_MAX).optional(),
});

export const PreviewTitleChangeSchema = z.strictObject({ title: previewTitle.nullable() });
export const PreviewIconChangeSchema = z.strictObject({ icon: PreviewIconSchema.nullable() });
export const PreviewWatermarkChangeSchema = z.strictObject({
  watermark: z.enum(WATERMARK_CHOICES),
});

/** How long a public share link lasts; the server caps it at its own maximum. */
export const PreviewShareSchema = z.strictObject({ ttl: z.string().max(16).optional() });

export const PREVIEW_PASSWORD_HEADER = "gangway-preview-password";

export const DeployRequestSchema = z.strictObject({
  source: DeploySourceSchema,
  name: z.string().min(1).max(40).optional(),
  title: previewTitle.optional(),
  icon: PreviewIconSchema.optional(),
  visibility: z.enum(VISIBILITY_VALUES).optional(),
  ttl: z.string().max(16).nullable().optional(),
  hostId: z.string().min(1).max(64).optional(),
  template: templateId.optional(),
  project: z.string().min(1).max(64).optional(),
  password: PasswordChoiceSchema.optional(),
  passwordLogin: PasswordLoginSchema.optional(),
  watermark: z.enum(WATERMARK_CHOICES).optional(),
  /** The wildcard domain it is named under; absent follows the project, then the default. */
  domain: DomainNameSchema.optional(),
  /** Secrets for this preview alone: stored on it, merged over the org's and project's. */
  secrets: envMap.optional(),
});
export type DeployRequest = z.infer<typeof DeployRequestSchema>;

const previewState = z.enum(PREVIEW_STATE_VALUES);

export const PreviewListQuerySchema = z.object({
  state: z.array(previewState).max(7).optional(),
  hostId: z.string().optional(),
  includeDestroyed: z.enum(["true", "false"]).optional(),
  /** A page of at most this many, newest first; none for all of them. */
  limit: z.coerce.number().int().min(1).max(500).optional(),
  /** The `next` of the page before. */
  cursor: z
    .string()
    .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    .optional(),
});

export const PreviewLogsQuerySchema = z.object({
  tail: z.coerce.number().int().min(1).max(5_000).optional(),
});

// Lowercased because users.email is UNIQUE without NOCASE.
export const email = z.string().trim().toLowerCase().pipe(z.string().email().max(254));

export const password = z.string().min(12, "at least 12 characters").max(256);

export const LoginRequestSchema = z.strictObject({
  email,
  // Not the `password` schema: a failed login must not reveal the password rules.
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

// A first password to hand over, or `invite: true` to email a link to choose one.
export const CreateUserSchema = z
  .strictObject({
    email,
    roleId,
    password: password.optional(),
    invite: z.literal(true).optional(),
  })
  .refine((u) => (u.password === undefined) !== (u.invite === undefined), {
    message: "give a first password, or invite: true to email a link, not both",
  });
export type CreateUserRequest = z.infer<typeof CreateUserSchema>;

export const UpdateUserSchema = z
  .strictObject({
    roleId: roleId.optional(),
    disabled: z.boolean().optional(),
    password: password.optional(),
  })
  .refine((u) => Object.keys(u).length > 0, "nothing to change");
export type UpdateUserRequest = z.infer<typeof UpdateUserSchema>;

export const ChangePasswordSchema = z.strictObject({
  current: z.string().min(1).max(1024),
  next: password,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordSchema>;

export const SecretTargetsSchema = z.strictObject({
  previews: z.enum(["own", "all"]),
  projects: z.union([z.literal("all"), z.array(z.string().min(1).max(64)).max(100)]),
  org: z.boolean(),
});

export const CreateTokenSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(SCOPES)).min(1).max(SCOPES.length),
  expiresIn: z.string().max(16).optional(),
  /** With the secrets scope: where it may set them. Defaults to the previews it deploys. */
  secretTargets: SecretTargetsSchema.optional(),
});
export type CreateTokenRequest = z.infer<typeof CreateTokenSchema>;

export const SetRolePermissionsSchema = z.strictObject({
  permissions: z
    .array(z.string().refine((s): s is Permission => isPermission(s), "not a known permission"))
    .max(ALL_PERMISSIONS.length),
});
export type SetRolePermissionsRequest = z.infer<typeof SetRolePermissionsSchema>;

export const SetSettingsSchema = z.strictObject({
  values: z
    .record(z.string().min(1).max(64), z.unknown())
    .refine((v) => Object.keys(v).length > 0, "no settings given"),
});
export type SetSettingsRequest = z.infer<typeof SetSettingsSchema>;

export const DISABLE_UI_PHRASE = "disable the UI";
export const SetSurfacesSchema = z
  .strictObject({
    ui: z.boolean().optional(),
    mcp: z.boolean().optional(),
    confirm: z.string().max(100).optional(),
  })
  .refine((v) => v.ui !== undefined || v.mcp !== undefined, "name ui, mcp, or both");
export type SetSurfacesRequest = z.infer<typeof SetSurfacesSchema>;

export const ManifestExchangeSchema = z.strictObject({
  code: z.string().min(1).max(200),
  state: z.string().min(1).max(200),
});
export type ManifestExchangeRequest = z.infer<typeof ManifestExchangeSchema>;

export const ProjectSlugSchema = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/,
    "a slug is 1-24 lowercase letters, digits and hyphens",
  );
export const RepositorySchema = z
  .string()
  .trim()
  .regex(/^[\w.-]+\/[\w.-]+$/, "a repository is owner/name");
const prTrigger = z.enum(["workflow", "webhook"]);

export const ProjectCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(64),
  slug: ProjectSlugSchema.optional(),
  repository: RepositorySchema.optional(),
  prTrigger: prTrigger.optional(),
  templateId: z.string().min(1).max(32).nullable().optional(),
});
export type ProjectCreateRequest = z.infer<typeof ProjectCreateSchema>;

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
  repository: RepositorySchema.nullable().optional(),
  prTrigger: prTrigger.optional(),
  slug: ProjectSlugSchema.optional(),
  enabled: z.boolean().optional(),
  visibility: z.enum(["public", "unlisted", "private"]).nullable().optional(),
  ttl: z.string().max(16).nullable().optional(),
  forks: z.enum(["ask", "auto", "never"]).optional(),
  drafts: z.boolean().optional(),
  templateId: templateId.nullable().optional(),
  prClearance: z.enum(["none", "low", "standard", "high"]).nullable().optional(),
  forkClearance: z.enum(["none", "low", "standard", "high"]).optional(),
  watermark: z.enum(["on", "off"]).nullable().optional(),
  domain: DomainNameSchema.nullable().optional(),
});
export type ProjectPatchRequest = z.infer<typeof ProjectPatchSchema>;

const templateFields = {
  name: z.string().trim().min(1).max(64),
  description: z.string().max(500),
  visibility: z.enum(VISIBILITY_VALUES),
  ttl: z.string().max(16).nullable(),
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
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  action: z.string().max(64).optional(),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;
