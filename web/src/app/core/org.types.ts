export type OrgState = 'active' | 'suspended';

/** One org the signed-in person belongs to; `current` is the one their session acts in. */
export type MyOrg = {
  id: string;
  slug: string;
  name: string;
  home: boolean;
  state: OrgState;
  role: { id: string; name: string };
  current: boolean;
};

export type OrgLimits = {
  storageBytes?: number;
  maxSites?: number;
  maxActive?: number;
  maxAwake?: number;
  maxLifetimeMs?: number;
  memoryBytes?: number;
  maxMembers?: number;
  containers?: boolean;
};

export type OrgOverview = {
  org: { id: string; slug: string; name: string; home: boolean; state: OrgState };
  planLabel: string | null;
  limits: OrgLimits | null;
  usage: { sites: number; apps: number; storageBytes: number; members: number };
  billingUrl: string | null;
};

export type OrgMember = {
  id: string;
  email: string;
  role: { id: string; name: string };
  disabled: boolean;
  invited: boolean;
  joinedAt: number;
};
