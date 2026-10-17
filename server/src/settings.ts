import { z } from "zod";
import { parseDuration } from "@gangway/shared/duration";
import { OrgLimitsSchema } from "@gangway/shared/orgs-api";
import { parseBytes } from "./util/bytes.ts";
import type { OrgSettings } from "./settings-org.ts";
import { currentOrg } from "./tenancy/scope.ts";

export type SettingSource = "config" | "database" | "default";

export type Effective<T> = {
  key: string;
  value: T;
  source: SettingSource;
  managedByConfig: boolean;
};

/** Whose a setting is: the whole server's, or each org's, which falls back to the server's value. */
export type SettingScope = "instance" | "org";

export type SettingDef<T> = {
  key: string;
  schema: z.ZodType<T>;
  fallback: T;
  secret: boolean;
  scope: SettingScope;
};

export type SettingView = {
  key: string;
  source: SettingSource;
  managedByConfig: boolean;
  secret: boolean;
  scope: SettingScope;
  value: unknown;
  set: boolean;
};

function def<T>(
  key: string,
  schema: z.ZodType<T>,
  fallback: T,
  o: { secret?: boolean; scope?: SettingScope } = {},
): SettingDef<T> {
  return { key, schema, fallback, secret: o.secret === true, scope: o.scope ?? "instance" };
}

const ORG = { scope: "org" } as const;

const templateRef = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/,
    "a template id is 1-32 lowercase letters, digits and hyphens",
  );

// smtp:// upgrades with STARTTLS when the server offers it; smtps:// is TLS from the start (465).
const smtpUrl = z
  .string()
  .trim()
  .refine(
    (v) => v === "" || (/^(?:smtps?|https):\/\/[^/]/.test(v) && URL.canParse(v) && decodes(v)),
    "an smtp://, smtps:// or https:// URL, like smtp://user:password@smtp.example.com:587",
  );

const reportUrl = z
  .string()
  .trim()
  .refine(
    (v) => v === "" || (v.startsWith("https://") && URL.canParse(v)),
    "an https:// URL, or empty for no report link",
  );

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

const reportDomains = z.preprocess(
  (v) =>
    typeof v === "string"
      ? v
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      : v,
  z.array(z.string().regex(HOSTNAME, "a lowercase hostname, like example.com")).max(50),
);

const RFC6750_BEARER_TOKEN = /^(?:[\w.~+/-]+=*)?$/;

// An env var or the settings form sends JSON as text.
function jsonText(v: unknown): unknown {
  if (typeof v !== "string") {
    return v;
  }
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

function decodes(v: string): boolean {
  const u = new URL(v);
  try {
    const username = decodeURIComponent(u.username);
    const password = decodeURIComponent(u.password);
    return u.protocol !== "https:" || RFC6750_BEARER_TOKEN.test(password || username);
  } catch {
    return false;
  }
}

const mailFrom = z
  .string()
  .trim()
  .max(320)
  .refine(
    (v) => v === "" || /^(?:[^<>@\r\n]*<[^<>\s@]+@[^<>\s@]+>|[^<>\s@]+@[^<>\s@]+)$/.test(v),
    'an address, or a name and an address like "gangway <noreply@example.com>"',
  );

const oidcIssuer = z
  .string()
  .trim()
  .refine(
    (v) =>
      v === "" ||
      (URL.canParse(v) &&
        new URL(v).protocol === "https:" &&
        new URL(v).search === "" &&
        new URL(v).hash === ""),
    "an https:// issuer URL, like https://auth.example.com/application/o/gangway/",
  );

// A PEM pasted into an env var arrives with literal \n sequences.
const pem = z.string().transform((v) => v.replaceAll(String.raw`\n`, "\n").trim());

export const SETTINGS = {
  baseDomain: def("baseDomain", z.string().min(1), "preview.localhost"),
  // Empty names previews under baseDomain, as before a second domain existed.
  previewDomain: def("previewDomain", z.string(), ""),
  surfacesUi: def("surfaces.ui", z.boolean(), true),
  surfacesMcp: def("surfaces.mcp", z.boolean(), false),
  templatePr: def("templates.default.pr", templateRef, "default", ORG),
  templateApi: def("templates.default.api", templateRef, "default", ORG),
  templateManual: def("templates.default.manual", templateRef, "default", ORG),
  previewPasswordMode: def(
    "previews.password.mode",
    z.enum(["off", "shared", "generated"]),
    "off",
    ORG,
  ),
  previewPasswordLogin: def("previews.password.login", z.boolean(), false, ORG),
  previewPasswordShared: def(
    "previews.password.shared",
    z.object({ hash: z.string().min(1), salt: z.string().min(1) }).nullable(),
    null,
    { secret: true, scope: "org" },
  ),
  previewWatermark: def("previews.watermark", z.boolean(), true, ORG),
  previewWatermarkLink: def(
    "previews.watermark.link",
    z.url().or(z.literal("")),
    "https://gangway.sh",
    ORG,
  ),
  // The server's, never an org's: it is where reports of abuse go.
  previewWatermarkReport: def("previews.watermark.report", reportUrl, ""),
  // Previews under these domains always carry the report link, even with the mark off.
  previewReportDomains: def("previews.report.domains", reportDomains, []),
  // The theme an artifact gets when it names none; "chart" is gangway's own.
  artifactTheme: def(
    "artifacts.theme",
    z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/),
    "chart",
    ORG,
  ),
  artifactCustomCss: def("artifacts.customCss", z.boolean(), true, ORG),
  // Off puts static sites and artifacts back in nginx containers.
  previewsServeStatic: def("previews.serveStatic", z.boolean(), true),
  previewsShare: def("previews.share.enabled", z.boolean(), false, ORG),
  previewsShareMaxTtl: def(
    "previews.share.maxTtl",
    z.string().refine((v) => parseDuration(v) !== null, "a duration like 30m, 24h or 7d"),
    "24h",
    ORG,
  ),
  // Per container. Memory and processes are what take a host down; 0 turns a limit off.
  previewsMemory: def(
    "previews.limits.memory",
    z.string().refine((v) => parseBytes(v) !== null, "a size like 512m or 2g, or 0 for no limit"),
    "1g",
  ),
  previewsCpus: def("previews.limits.cpus", z.coerce.number().min(0), 2),
  previewsPids: def("previews.limits.pids", z.coerce.number().int().min(0), 1024),
  // Per preview, replicas counted; container previews at once, served sites not counted.
  previewsContainers: def("previews.limits.containers", z.coerce.number().int().min(0), 10),
  previewsActive: def("previews.limits.active", z.coerce.number().int().min(0), 50),
  previewsActivePerUser: def(
    "previews.limits.activePerUser",
    z.coerce.number().int().min(0),
    20,
    ORG,
  ),
  // Builds run outside every preview's limits, so a burst of them would take the whole host.
  previewsBuilds: def("previews.limits.builds", z.coerce.number().int().min(0), 2),
  previewsBuildQueue: def("previews.limits.buildQueue", z.coerce.number().int().min(0), 10),
  previewsBuildTimeout: def(
    "previews.limits.buildTimeout",
    z
      .string()
      .refine((v) => v === "0" || parseDuration(v) !== null, "a duration like 15m, or 0 for none"),
    "15m",
  ),
  previewsBuildMemory: def(
    "previews.limits.buildMemory",
    z.string().refine((v) => parseBytes(v) !== null, "a size like 512m or 2g, or 0 for no check"),
    "512m",
  ),
  previewsBuildDisk: def(
    "previews.limits.buildDisk",
    z.string().refine((v) => parseBytes(v) !== null, "a size like 512m or 2g, or 0 for no check"),
    "2g",
  ),
  // Per minute, for preview traffic; 0 turns a limit off.
  limitsRequestsClient: def("limits.requests.client", z.coerce.number().int().min(0), 1200),
  limitsRequestsPreview: def("limits.requests.preview", z.coerce.number().int().min(0), 12000),
  limitsSocketsClient: def("limits.websockets.client", z.coerce.number().int().min(0), 100),
  // Days kept before the daily prune deletes them; 0 keeps them for good.
  retentionEvents: def("retention.events.days", z.coerce.number().int().min(0), 30),
  retentionAudit: def("retention.audit.days", z.coerce.number().int().min(0), 0),
  retentionDestroyed: def("retention.destroyedPreviews.days", z.coerce.number().int().min(0), 0),
  // Off for installs that should make no outbound call to GitHub.
  updatesCheck: def("updates.check", z.boolean(), true),
  acmeDirectoryUrl: def(
    "acme.directoryUrl",
    z.url(),
    // Staging by default: production allows 50 certs per domain per week.
    "https://acme-staging-v02.api.letsencrypt.org/directory",
  ),
  acmeEmail: def("acme.email", z.email().or(z.literal("")), ""),
  mailSmtpUrl: def("mail.smtp.url", smtpUrl, "", { secret: true }),
  mailFrom: def("mail.from", mailFrom, ""),
  // Sign-in through an OpenID Connect provider; on when the issuer, client id and secret are set.
  oidcIssuer: def("auth.oidc.issuer", oidcIssuer, ""),
  oidcClientId: def("auth.oidc.clientId", z.string().trim().max(512), ""),
  oidcClientSecret: def("auth.oidc.clientSecret", z.string().max(1024), "", { secret: true }),
  oidcLabel: def("auth.oidc.label", z.string().trim().min(1).max(60), "Sign in with SSO"),
  passwordLogin: def("auth.passwords", z.boolean(), true),
  // Hosted: someone new this issuer vouches for gets an account and an org of their own.
  ssoSignup: def("auth.sso.signup", z.boolean(), false),
  ssoSignupIssuer: def("auth.sso.signupIssuer", oidcIssuer, ""),
  ssoSignupLimits: def("auth.sso.signupLimits", z.preprocess(jsonText, OrgLimitsSchema), {}),
  cloudflareApiToken: def("acme.cloudflare.apiToken", z.string(), "", { secret: true }),
  cloudflareZoneId: def("acme.cloudflare.zoneId", z.string(), ""),
  acmeDnsUrl: def("acme.acmeDns.url", z.url({ protocol: /^https$/ }).or(z.literal("")), ""),
  acmeDnsUsername: def("acme.acmeDns.username", z.string(), ""),
  acmeDnsPassword: def("acme.acmeDns.password", z.string(), "", { secret: true }),
  acmeDnsSubdomain: def("acme.acmeDns.subdomain", z.string(), ""),
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
  version?(): number;
}

export class MemorySettingsStore implements SettingsStore {
  readonly #m = new Map<string, unknown>();
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
  readonly #overrides: Record<string, unknown>;
  readonly #store: SettingsStore;
  readonly #orgs: OrgSettings | null;
  readonly #parsed = new Map<string, Effective<unknown>>();
  #parsedAt = -1;
  readonly #defaults = new Map<string, () => unknown>();

  constructor(overrides: Record<string, unknown>, store: SettingsStore, orgs?: OrgSettings) {
    this.#overrides = overrides;
    this.#store = store;
    this.#orgs = orgs ?? null;
  }

  defaultTo<T>(d: SettingDef<T>, fallback: () => T): void {
    this.#defaults.set(d.key, fallback);
    this.#parsed.clear();
  }

  isManagedByConfig(key: string): boolean {
    return Object.hasOwn(this.#overrides, key);
  }

  // The org whose own value applies, the one named else the request's; null reads the server's.
  #orgFor(d: Pick<SettingDef<unknown>, "scope">, org: string | null | undefined): string | null {
    if (d.scope !== "org" || !this.#orgs) {
      return null;
    }
    const o = org === undefined ? currentOrg() : org;
    return o === null || o === this.#orgs.home ? null : o;
  }

  orgOfPreview(previewId: string): string | null {
    return this.#orgs?.ofPreview?.(previewId) ?? null;
  }

  isOtherOrg(org?: string | null): boolean {
    const o = org === undefined ? currentOrg() : org;
    return this.#orgs !== null && o !== null && o !== this.#orgs.home;
  }

  #version(): number | undefined {
    const a = this.#store.version?.();
    if (a === undefined || !this.#orgs) {
      return a;
    }
    const b = this.#orgs.store.version?.();
    return b === undefined ? undefined : a + b;
  }

  effective<T>(d: SettingDef<T>, org?: string | null): Effective<T> {
    const o = this.#orgFor(d, org);
    const version = this.#version();
    if (version === undefined) {
      return this.#resolve(d, o);
    }
    if (version !== this.#parsedAt) {
      this.#parsed.clear();
      this.#parsedAt = version;
    }
    const at = o === null ? d.key : `${o}\n${d.key}`;
    const hit = this.#parsed.get(at) as Effective<T> | undefined;
    if (hit) {
      return hit;
    }
    const e = this.#resolve(d, o);
    this.#parsed.set(at, e);
    return e;
  }

  #resolve<T>(d: SettingDef<T>, org: string | null): Effective<T> {
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

    if (org !== null) {
      const own = this.#orgs?.store.get(org, d.key);
      if (own !== undefined) {
        const parsed = d.schema.safeParse(own);
        if (parsed.success) {
          return { key: d.key, value: parsed.data, source: "database", managedByConfig: false };
        }
      }
    }

    const stored = this.#store.get(d.key);
    if (stored !== undefined) {
      const parsed = d.schema.safeParse(stored);
      if (parsed.success) {
        // To another org, the server's value is its default until it sets its own.
        const source = org === null ? "database" : "default";
        return { key: d.key, value: parsed.data, source, managedByConfig: false };
      }
    }

    const fallback = this.#defaults.get(d.key);
    const value = fallback ? (fallback() as T) : d.fallback;
    return { key: d.key, value, source: "default", managedByConfig: false };
  }

  get<T>(d: SettingDef<T>, org?: string | null): T {
    return this.effective(d, org).value;
  }

  set<T>(d: SettingDef<T>, value: T, org?: string | null): void {
    if (this.isManagedByConfig(d.key)) {
      throw new Error(`"${d.key}" is managed by config and cannot be changed at runtime`);
    }
    if (d.scope === "instance" && this.isOtherOrg(org)) {
      throw new Error(`"${d.key}" is the server's setting, and only the home org may change it`);
    }
    const parsed = d.schema.parse(value);
    const o = this.#orgFor(d, org);
    if (o === null) {
      this.#store.set(d.key, parsed);
    } else {
      this.#orgs?.store.set(o, d.key, parsed);
    }
  }

  snapshot(): Effective<unknown>[] {
    return Object.values(SETTINGS).map((d) => this.effective(d as SettingDef<unknown>));
  }

  view(org?: string | null): SettingView[] {
    const other = this.isOtherOrg(org);
    return Object.values(SETTINGS)
      .filter((d) => !other || d.scope === "org")
      .map((d) => {
        // TypeScript 7 needs the widening; the TypeScript 6 that ESLint runs does not.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        const e = this.effective(d as SettingDef<unknown>, org);
        const set = e.value !== "" && e.value !== null && e.value !== undefined;
        return {
          key: e.key,
          source: e.source,
          managedByConfig: e.managedByConfig,
          secret: d.secret,
          scope: d.scope,
          value: d.secret ? null : e.value,
          set,
        };
      });
  }
}
