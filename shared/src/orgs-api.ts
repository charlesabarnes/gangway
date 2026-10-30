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
  buildMinutes: count.optional(),
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

export type OrgSeats = Org & { members: number };

export const SuspendSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
});

export const TakedownSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
});

/** A hostname the operator took down: it answers 410 until lifted. */
export type Takedown = {
  hostname: string;
  previewId: string;
  orgId: string;
  reason: string;
  createdBy: string;
  createdAt: number;
};

export type MyOrg = {
  id: string;
  slug: string;
  name: string;
  home: boolean;
  state: OrgState;
  role: { id: string; name: string };
  current: boolean;
};

export const SwitchOrgSchema = z.strictObject({ orgId: z.string().min(1).max(64) });

export type OrgMember = {
  id: string;
  email: string;
  role: { id: string; name: string };
  disabled: boolean;
  invited: boolean;
  joinedAt: number;
};

/** The current org as its own people see it: what the plan allows next to what is in use. */
export type OrgOverview = {
  org: Pick<Org, "id" | "slug" | "name" | "home" | "state">;
  planLabel: string | null;
  limits: OrgLimits | null;
  usage: {
    sites: number;
    apps: number;
    storageBytes: number;
    members: number;
    buildMinutes: number;
  };
  billingUrl: string | null;
};
