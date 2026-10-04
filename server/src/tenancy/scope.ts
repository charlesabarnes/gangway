import { AsyncLocalStorage } from "node:async_hooks";

type Store = { orgId: string | null };

const current = new AsyncLocalStorage<Store>();

/** Runs `fn` as one org; outside any of these, work spans every org (sweepers, reconciler). */
export const withOrg = <T>(orgId: string, fn: () => T): T => current.run({ orgId }, fn);

/** A request before its credential is known: org-scoped data is refused until withOrg names one. */
export const beforeOrg = <T>(fn: () => T): T => current.run({ orgId: null }, fn);

export const acrossOrgs = <T>(fn: () => T): T => current.exit(fn);

export type OrgScope = { org: string } | "fleet";

export function orgScope(): OrgScope {
  const s = current.getStore();
  if (!s) {
    return "fleet";
  }
  if (s.orgId === null) {
    throw new Error("org-scoped data was read before the request named its org");
  }
  return { org: s.orgId };
}

export function currentOrg(): string | null {
  return current.getStore()?.orgId ?? null;
}

export function orgFilter(column = "org_id"): { sql: string; params: { org?: string } } {
  const s = orgScope();
  return s === "fleet"
    ? { sql: "1", params: {} }
    : { sql: `${column} = $org`, params: { org: s.org } };
}
