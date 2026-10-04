import { z } from "zod";

const count = z.int().min(0);

/** What an org may use; a key left out has no limit. Plans are this data, never names in code. */
export const OrgLimitsSchema = z.strictObject({
  storageBytes: count.optional(),
  maxSites: count.optional(),
  maxActive: count.optional(),
  maxAwake: count.optional(),
  maxLifetimeMs: count.optional(),
  memoryBytes: count.optional(),
  maxMembers: count.optional(),
  containers: z.boolean().optional(),
});
export type OrgLimits = z.infer<typeof OrgLimitsSchema>;

export type OrgState = "active" | "suspended";

/** It ends every preview hostname in the org, so short, and plain enough never to collide. */
export const OrgCreateSchema = z.strictObject({
  slug: z.string().regex(/^[a-z0-9]{1,20}$/, "lowercase letters and digits, at most 20"),
  name: z.string().trim().min(1).max(64),
});
export type OrgCreateRequest = z.infer<typeof OrgCreateSchema>;

export const OrgLimitsChangeSchema = z.strictObject({
  planLabel: z.string().trim().min(1).max(64).nullable().optional(),
  limits: OrgLimitsSchema,
});

export type Org = {
  id: string;
  slug: string;
  name: string;
  home: boolean;
  state: OrgState;
  createdAt: number;
  updatedAt: number;
};
