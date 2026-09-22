/**
 * Request schemas for the public API. ADR-0003: the REST handler, the webhook receiver
 * and the MCP `deploy` tool all validate with THESE, so there is one definition of what a
 * deploy request is, shared with the Angular client for free.
 */
import { z } from "zod";
import { ALL_PERMISSIONS, SCOPES, isPermission, type Permission } from "./permissions.ts";

/** Runtime copies of the domain's string unions, so the web contract test has something to compare. */
export const PREVIEW_STATE_VALUES = ["building", "starting", "awake", "asleep", "failed", "destroying", "destroyed"] as const;
export const VISIBILITY_VALUES = ["public", "unlisted", "private"] as const;

/** A Docker image reference. Conservative on purpose: it becomes an argument to a CLI. */
const imageRef = z.string().max(255).regex(/^[a-z0-9][a-z0-9._/:@-]*$/i, "not a valid image reference");

const envMap = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "not a valid environment variable name"),
  z.string().max(32_768),
).refine((e) => Object.keys(e).length <= 100, "at most 100 variables");

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
  port: z.coerce.number().int().min(1).max(65535).optional(),
});
export const TARBALL_CONTENT_TYPES = ["application/gzip", "application/x-gzip", "application/x-tar", "application/octet-stream"] as const;

export const DeployRequestSchema = z.strictObject({
  source: DeploySourceSchema,
  name: z.string().min(1).max(40).optional(),
  visibility: z.enum(VISIBILITY_VALUES).optional(),
  /** `12h`, `7d`; null for no expiry. Omitted means the server default. */
  ttl: z.string().max(16).nullable().optional(),
  hostId: z.string().min(1).max(64).optional(),
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

export const SetupRequestSchema = z.strictObject({ token: z.string().min(1).max(256), email, password });
export type SetupRequest = z.infer<typeof SetupRequestSchema>;

const roleId = z.string().min(1).max(64);

export const CreateUserSchema = z.strictObject({ email, password, roleId });
export type CreateUserRequest = z.infer<typeof CreateUserSchema>;

export const UpdateUserSchema = z.strictObject({
  roleId: roleId.optional(),
  disabled: z.boolean().optional(),
  /** An admin reset. Ends every session the account has. */
  password: password.optional(),
}).refine((u) => Object.keys(u).length > 0, "nothing to change");
export type UpdateUserRequest = z.infer<typeof UpdateUserSchema>;

export const ChangePasswordSchema = z.strictObject({ current: z.string().min(1).max(1024), next: password });
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
  permissions: z.array(z.string().refine((s): s is Permission => isPermission(s), "not a known permission")).max(ALL_PERMISSIONS.length),
});
export type SetRolePermissionsRequest = z.infer<typeof SetRolePermissionsSchema>;

/** `PUT /v1/settings`: a partial map of key -> value. Each value is checked against its own schema. */
export const SetSettingsSchema = z.strictObject({
  values: z.record(z.string().min(1).max(64), z.unknown()).refine((v) => Object.keys(v).length > 0, "no settings given"),
});
export type SetSettingsRequest = z.infer<typeof SetSettingsSchema>;

/** `POST /v1/github/manifest/exchange`: what GitHub sent the browser back with. */
export const ManifestExchangeSchema = z.strictObject({
  code: z.string().min(1).max(200),
  state: z.string().min(1).max(200),
});
export type ManifestExchangeRequest = z.infer<typeof ManifestExchangeSchema>;

/** `PATCH /v1/repos/:id`: the per-repository knobs (ADR-0011). */
export const RepoPatchSchema = z.strictObject({
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/, "a slug is 1-24 lowercase letters, digits and hyphens").optional(),
  enabled: z.boolean().optional(),
  visibility: z.enum(["public", "unlisted", "private"]).nullable().optional(),
  ttl: z.string().max(16).nullable().optional(),
  forks: z.enum(["ask", "auto", "never"]).optional(),
  drafts: z.boolean().optional(),
  prClearance: z.enum(["none", "low", "standard", "high"]).optional(),
  forkClearance: z.enum(["none", "low", "standard", "high"]).optional(),
});
export type RepoPatchRequest = z.infer<typeof RepoPatchSchema>;

/** `PATCH /v1/repos/:id/env`: merge secrets in, take names out. Values are never returned. */
const secretLevel = z.enum(["low", "standard", "high"]);
export const RepoEnvPatchSchema = z.strictObject({
  set: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "not a valid variable name"), z.union([z.string(), z.strictObject({ value: z.string(), level: secretLevel })])).optional(),
  unset: z.array(z.string()).max(100).optional(),
  levels: z.record(z.string(), secretLevel).optional(),
}).refine((v) => Object.keys(v.set ?? {}).length > 0 || (v.unset ?? []).length > 0 || Object.keys(v.levels ?? {}).length > 0, "nothing to change");
export type RepoEnvPatchRequest = z.infer<typeof RepoEnvPatchSchema>;

export const AuditQuerySchema = z.object({
  /** Entries with a seq BELOW this one: the log is read newest-first. */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  action: z.string().max(64).optional(),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;
