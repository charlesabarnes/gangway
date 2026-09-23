import { randomBytes } from "node:crypto";

const MANIFEST_STATE_TTL_MS = 10 * 60_000;

// issues: read is required for issue_comment, whatever the docs say.
const APP_PERMISSIONS = {
  contents: "read",
  metadata: "read",
  issues: "read",
  pull_requests: "write",
  deployments: "write",
} as const;
const APP_EVENTS = ["pull_request", "issue_comment"] as const;

export type Manifest = {
  name: string;
  url: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  public: boolean;
  default_permissions: typeof APP_PERMISSIONS;
  default_events: readonly string[];
  description: string;
};

export function buildManifest(o: {
  baseDomain: string;
  appOrigin: string;
  hooksOrigin: string;
}): Manifest {
  return {
    name: `gangway ${o.baseDomain}`.slice(0, 34),
    url: o.appOrigin,
    hook_attributes: { url: `${o.hooksOrigin}/github`, active: true },
    redirect_url: `${o.appOrigin}/github/callback`,
    public: false,
    default_permissions: APP_PERMISSIONS,
    default_events: APP_EVENTS,
    description: `Pull-request previews on ${o.baseDomain}`,
  };
}

export class ManifestStates {
  readonly #issued = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  issue(): string {
    this.#sweep();
    const state = randomBytes(24).toString("base64url");
    this.#issued.set(state, this.#now() + MANIFEST_STATE_TTL_MS);
    return state;
  }

  consume(state: string): boolean {
    this.#sweep();
    const exp = this.#issued.get(state);
    if (exp === undefined) return false;
    this.#issued.delete(state);
    return exp > this.#now();
  }

  #sweep(): void {
    const now = this.#now();
    for (const [s, exp] of this.#issued) if (exp <= now) this.#issued.delete(s);
  }
}
