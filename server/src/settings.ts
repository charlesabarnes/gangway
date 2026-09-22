/**
 * Effective-settings resolver (§10.5).
 *
 *   effective(key) = config/env override, if present
 *                    else the database value
 *                    else the built-in default
 *
 * "One rule, and it is what makes the server declaratively deployable." A setting pinned
 * in config reports managedByConfig, so the UI renders it disabled and labelled
 * *managed by config* rather than silently failing when clicked.
 */
import { z } from "zod";
import { parseDuration } from "./util/duration.ts";

/** A template's `idleAfter` / `x-gangway.idle` as milliseconds; 0 means never. */
export function idleMs(text: string): number {
  if (text === "never" || text === "0") return 0;
  return parseDuration(text) ?? 0;
}

export type SettingSource = "config" | "database" | "default";

export type Effective<T> = {
  key: string;
  value: T;
  source: SettingSource;
  managedByConfig: boolean;
};

/**
 * `secret`: the value is never reported, only whether one is set. A snapshot of settings
 * with the Cloudflare token or the GitHub App's private key in it is exactly the leak
 * `GET /v1/settings` was deferred over (ADR-0011).
 */
export type SettingDef<T> = { key: string; schema: z.ZodType<T>; fallback: T; secret: boolean };

/** What the API reports: a secret's value is withheld, its presence is not. */
export type SettingView = {
  key: string; source: SettingSource; managedByConfig: boolean; secret: boolean;
  value: unknown | null; set: boolean;
};

function def<T>(key: string, schema: z.ZodType<T>, fallback: T, o: { secret?: boolean } = {}): SettingDef<T> {
  return { key, schema, fallback, secret: o.secret === true };
}

const templateRef = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/, "a template id is 1-32 lowercase letters, digits and hyphens");

/** A PEM pasted into an env var arrives with literal `\n`; GitHub's download has real newlines. */
const pem = z.string().transform((v) => v.replace(/\\n/g, "\n").trim());

export const SETTINGS = {
  baseDomain: def("baseDomain", z.string().min(1), "preview.localhost"),
  surfacesUi: def("surfaces.ui", z.boolean(), true),
  // Defaults: UI on, MCP off. MCP is an additional public auth surface that matters only
  // once a token exists for an agent, so opt-in is the safer posture (§10.5).
  surfacesMcp: def("surfaces.mcp", z.boolean(), false),
  // ADR-0013: the template each trigger deploys with unless the request or the repository
  // names one. The old `defaults.*` keys became the `default` template's fields.
  templatePr: def("templates.default.pr", templateRef, "default"),
  templateApi: def("templates.default.api", templateRef, "default"),
  templateManual: def("templates.default.manual", templateRef, "default"),
  acmeDirectoryUrl: def(
    "acme.directoryUrl",
    z.string().url(),
    // Staging by default. Production is an explicit opt-in: 50 certs per registered
    // domain per week, and a renewal-loop bug burns that budget for the whole domain.
    "https://acme-staging-v02.api.letsencrypt.org/directory",
  ),
  acmeEmail: def("acme.email", z.string().email().or(z.literal("")), ""),
  cloudflareApiToken: def("acme.cloudflare.apiToken", z.string(), "", { secret: true }),
  cloudflareZoneId: def("acme.cloudflare.zoneId", z.string(), ""),
  // The GitHub App (ADR-0011). Filled by the manifest flow, or pinned from the environment.
  githubAppId: def("github.appId", z.string(), ""),
  githubAppSlug: def("github.appSlug", z.string(), ""),
  githubClientId: def("github.clientId", z.string(), ""),
  githubClientSecret: def("github.clientSecret", z.string(), "", { secret: true }),
  githubPrivateKey: def("github.privateKey", pem, "", { secret: true }),
  githubWebhookSecret: def("github.webhookSecret", z.string(), "", { secret: true }),
} as const;

export const SETTINGS_BY_KEY: ReadonlyMap<string, SettingDef<unknown>> =
  new Map(Object.values(SETTINGS).map((d) => [d.key, d as SettingDef<unknown>]));

export type SettingKey = (typeof SETTINGS)[keyof typeof SETTINGS]["key"];

/** The database side. Kept as an interface so unit tests need no SQLite. */
export interface SettingsStore {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown): void;
  all(): Record<string, unknown>;
}

export class MemorySettingsStore implements SettingsStore {
  #m = new Map<string, unknown>();
  get(key: string) { return this.#m.get(key); }
  set(key: string, value: unknown) { this.#m.set(key, value); }
  all() { return Object.fromEntries(this.#m); }
}

export class Settings {
  #overrides: Record<string, unknown>;
  #store: SettingsStore;

  constructor(overrides: Record<string, unknown>, store: SettingsStore) {
    this.#overrides = overrides;
    this.#store = store;
  }

  isManagedByConfig(key: string): boolean {
    return Object.hasOwn(this.#overrides, key);
  }

  effective<T>(d: SettingDef<T>): Effective<T> {
    const managedByConfig = this.isManagedByConfig(d.key);

    if (managedByConfig) {
      const parsed = d.schema.safeParse(this.#overrides[d.key]);
      // An invalid override must not silently fall through to the database: that would
      // make a typo in an env var look like it worked.
      if (!parsed.success) {
        throw new Error(
          `config override for "${d.key}" is invalid: ${parsed.error.issues[0]?.message ?? "bad value"}`,
        );
      }
      return { key: d.key, value: parsed.data, source: "config", managedByConfig: true };
    }

    const stored = this.#store.get(d.key);
    if (stored !== undefined) {
      const parsed = d.schema.safeParse(stored);
      // A corrupt database row falls back to the default rather than taking the server
      // down; it is recoverable from the UI, which a crash loop is not.
      if (parsed.success) {
        return { key: d.key, value: parsed.data, source: "database", managedByConfig: false };
      }
    }

    return { key: d.key, value: d.fallback, source: "default", managedByConfig: false };
  }

  get<T>(d: SettingDef<T>): T {
    return this.effective(d).value;
  }

  /**
   * Writes a setting. Refuses when the key is pinned in config, so the API cannot
   * pretend to change something the config will keep overriding on the next read.
   */
  set<T>(d: SettingDef<T>, value: T): void {
    if (this.isManagedByConfig(d.key)) {
      throw new Error(`"${d.key}" is managed by config and cannot be changed at runtime`);
    }
    this.#store.set(d.key, d.schema.parse(value));
  }

  /** Everything, values included. For the process itself -- never for a response. */
  snapshot(): Effective<unknown>[] {
    return Object.values(SETTINGS).map((d) => this.effective(d as SettingDef<unknown>));
  }

  /** `GET /v1/settings` and the Settings screen: secrets reported as set or not, never as values. */
  view(): SettingView[] {
    return Object.values(SETTINGS).map((d) => {
      const e = this.effective(d as SettingDef<unknown>);
      const set = e.value !== "" && e.value !== null && e.value !== undefined;
      return { key: e.key, source: e.source, managedByConfig: e.managedByConfig, secret: d.secret, value: d.secret ? null : e.value, set };
    });
  }
}
