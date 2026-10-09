/** Each org's own values for its org-scoped settings; an org without a row has the server's. */
export interface OrgSettingsStore {
  get(org: string, key: string): unknown;
  set(org: string, key: string, value: unknown): void;
  delete(org: string, key: string): void;
  version?(): number;
}

export class MemoryOrgSettingsStore implements OrgSettingsStore {
  readonly #m = new Map<string, unknown>();
  get(org: string, key: string) {
    return this.#m.get(`${org}\n${key}`);
  }
  set(org: string, key: string, value: unknown) {
    this.#m.set(`${org}\n${key}`, value);
  }
  delete(org: string, key: string) {
    this.#m.delete(`${org}\n${key}`);
  }
}

/** Where org-scoped settings live, and which org a preview is in. The home org has no rows. */
export type OrgSettings = {
  store: OrgSettingsStore;
  home: string;
  ofPreview?: (previewId: string) => string | null;
};
