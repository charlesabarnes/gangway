import { z } from "zod";
import { parseBytes } from "./util/bytes.ts";

export type SettingSource = "config" | "database" | "default";

export type Effective<T> = {
  key: string;
  value: T;
  source: SettingSource;
  managedByConfig: boolean;
};

export type SettingDef<T> = { key: string; schema: z.ZodType<T>; fallback: T; secret: boolean };

export type SettingView = {
  key: string;
  source: SettingSource;
  managedByConfig: boolean;
  secret: boolean;
  value: unknown;
  set: boolean;
};

function def<T>(
  key: string,
  schema: z.ZodType<T>,
  fallback: T,
  o: { secret?: boolean } = {},
): SettingDef<T> {
  return { key, schema, fallback, secret: o.secret === true };
}

const templateRef = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/,
    "a template id is 1-32 lowercase letters, digits and hyphens",
  );

// A PEM pasted into an env var arrives with literal \n sequences.
const pem = z.string().transform((v) => v.replace(/\\n/g, "\n").trim());

export const SETTINGS = {
  baseDomain: def("baseDomain", z.string().min(1), "preview.localhost"),
  // Empty names previews under baseDomain, as before a second domain existed.
  previewDomain: def("previewDomain", z.string(), ""),
  surfacesUi: def("surfaces.ui", z.boolean(), true),
  surfacesMcp: def("surfaces.mcp", z.boolean(), false),
  templatePr: def("templates.default.pr", templateRef, "default"),
  templateApi: def("templates.default.api", templateRef, "default"),
  templateManual: def("templates.default.manual", templateRef, "default"),
  previewPasswordMode: def("previews.password.mode", z.enum(["off", "shared", "generated"]), "off"),
  previewPasswordLogin: def("previews.password.login", z.boolean(), false),
  previewPasswordShared: def(
    "previews.password.shared",
    z.object({ hash: z.string().min(1), salt: z.string().min(1) }).nullable(),
    null,
    { secret: true },
  ),
  artifactBrand: def("artifacts.brand", z.boolean(), true),
  // Off puts static sites and artifacts back in nginx containers.
  previewsServeStatic: def("previews.serveStatic", z.boolean(), true),
  // Per container. Memory and processes are what take a host down; 0 turns a limit off.
  previewsMemory: def(
    "previews.limits.memory",
    z.string().refine((v) => parseBytes(v) !== null, "a size like 512m or 2g, or 0 for no limit"),
    "1g",
  ),
  previewsCpus: def("previews.limits.cpus", z.coerce.number().min(0), 0),
  previewsPids: def("previews.limits.pids", z.coerce.number().int().min(0), 1024),
  // Off for installs that should make no outbound call to GitHub.
  updatesCheck: def("updates.check", z.boolean(), true),
  acmeDirectoryUrl: def(
    "acme.directoryUrl",
    z.string().url(),
    // Staging by default: production allows 50 certs per domain per week.
    "https://acme-staging-v02.api.letsencrypt.org/directory",
  ),
  acmeEmail: def("acme.email", z.string().email().or(z.literal("")), ""),
  cloudflareApiToken: def("acme.cloudflare.apiToken", z.string(), "", { secret: true }),
  cloudflareZoneId: def("acme.cloudflare.zoneId", z.string(), ""),
  githubAppId: def("github.appId", z.string(), ""),
  githubAppSlug: def("github.appSlug", z.string(), ""),
  githubClientId: def("github.clientId", z.string(), ""),
  githubClientSecret: def("github.clientSecret", z.string(), "", { secret: true }),
  githubPrivateKey: def("github.privateKey", pem, "", { secret: true }),
  githubWebhookSecret: def("github.webhookSecret", z.string(), "", { secret: true }),
} as const;

export const SETTINGS_BY_KEY: ReadonlyMap<string, SettingDef<unknown>> = new Map(
  Object.values(SETTINGS).map((d) => [d.key, d as SettingDef<unknown>]),
);

export type SettingKey = (typeof SETTINGS)[keyof typeof SETTINGS]["key"];

export interface SettingsStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  all(): Record<string, unknown>;
}

export class MemorySettingsStore implements SettingsStore {
  #m = new Map<string, unknown>();
  get(key: string) {
    return this.#m.get(key);
  }
  set(key: string, value: unknown) {
    this.#m.set(key, value);
  }
  all() {
    return Object.fromEntries(this.#m);
  }
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
      // Throw rather than fall through, or an env var typo would look like it worked.
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
      if (parsed.success) {
        return { key: d.key, value: parsed.data, source: "database", managedByConfig: false };
      }
    }

    return { key: d.key, value: d.fallback, source: "default", managedByConfig: false };
  }

  get<T>(d: SettingDef<T>): T {
    return this.effective(d).value;
  }

  set<T>(d: SettingDef<T>, value: T): void {
    if (this.isManagedByConfig(d.key)) {
      throw new Error(`"${d.key}" is managed by config and cannot be changed at runtime`);
    }
    this.#store.set(d.key, d.schema.parse(value));
  }

  snapshot(): Effective<unknown>[] {
    return Object.values(SETTINGS).map((d) => this.effective(d as SettingDef<unknown>));
  }

  view(): SettingView[] {
    return Object.values(SETTINGS).map((d) => {
      // TypeScript 7 needs the widening; the TypeScript 6 that ESLint runs does not.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      const e = this.effective(d as SettingDef<unknown>);
      const set = e.value !== "" && e.value !== null && e.value !== undefined;
      return {
        key: e.key,
        source: e.source,
        managedByConfig: e.managedByConfig,
        secret: d.secret,
        value: d.secret ? null : e.value,
        set,
      };
    });
  }
}
