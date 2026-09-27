export type DomainKind = 'wildcard' | 'exact';
export type DomainStatus = 'pending' | 'active' | 'failed';
export type DnsRecord = { type: 'CNAME' | 'TXT'; name: string; value: string; purpose: string };
/** A claimed domain and the DNS records that prove and route it. */
export type DomainClaim = {
  id: string;
  name: string;
  kind: DomainKind;
  projectId: string | null;
  previewId: string | null;
  status: DomainStatus;
  claimId: string;
  routingOk: boolean;
  lastError: string | null;
  checkedAt: string | null;
  verifiedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  records: DnsRecord[];
};
export type DomainListing = { available: string[]; domains: DomainClaim[] };
export type OrgDomains = DomainListing & { control: string; defaultDomain: string };
export type PreviewDomains = DomainListing & { current: string };
