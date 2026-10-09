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

/** Where org-scoped settings live. The home org has no rows: it reads and writes the server's. */
export type OrgSettings = {
  store: OrgSettingsStore;
  home: string;
  /** The org a preview belongs to, for serving and sweeps, which span every org. */
  ofPreview?: (previewId: string) => string | null;
};
