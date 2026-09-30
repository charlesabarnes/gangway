import { z } from "zod";
import { ALL_PERMISSIONS, SCOPES, isPermission, type Permission } from "./permissions.ts";

// Lowercased because users.email is UNIQUE without NOCASE.
export const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

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
