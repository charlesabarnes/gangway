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

export type Org = {
  id: string;
  slug: string;
  name: string;
  home: boolean;
  state: OrgState;
  createdAt: number;
  updatedAt: number;
};
