/**
 * Cloudflare DNS-01 provider: plain `fetch` against the v4 REST API.
 *
 * No SDK: this is four endpoints. Authentication is a scoped API token (Zone:DNS:Edit on the
 * one zone) sent as a bearer. The Global API Key is deliberately not supported: it is
 * account-wide, cannot be scoped to a zone, and would sit in the settings table next to
 * everything else.
 */
import { AppError, internal, notFound, errorMessage } from "../../errors.ts";
import { Logger } from "../../logger.ts";
import { SingleFlight, retry, sleep, type BackoffOptions } from "../../util/async.ts";
import {
  nodeDnsQueries,
  waitForTxtPropagation,
  zoneCandidates,
  type DnsProvider,
  type DnsQueries,
} from "./provider.ts";

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** Narrower than `typeof fetch` so a plain function can be injected in tests. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

type CfError = { code: number; message: string };
type CfEnvelope<T> = { success?: boolean; errors?: CfError[]; result?: T | null };
type CfZone = { id: string; name: string };
type CfRecord = { id: string; name?: string; content?: string };

/** "Record does not exist" -- Cloudflare's 404 code for a DNS record. */
const RECORD_NOT_FOUND = 81044;

export type CloudflareOptions = {
  apiToken: string;
  /** Pins the zone instead of searching for it; useful for a single-zone scoped token. */
  zoneId?: string;
  fetch?: FetchLike;
  baseUrl?: string;
  log?: Logger;
  dns?: DnsQueries;
  retry?: BackoffOptions;
  propagationTimeoutMs?: number;
  propagationIntervalMs?: number;
};

export class CloudflareDnsProvider implements DnsProvider {
  readonly #token: string;
  readonly #zoneId: string | undefined;
  readonly #fetch: FetchLike;
  readonly #base: string;
  readonly #log: Logger;
  readonly #dns: DnsQueries;
  readonly #retry: BackoffOptions;
  readonly #propagationTimeoutMs: number;
  readonly #propagationIntervalMs: number;
  readonly #zones = new Map<string, CfZone>();
  readonly #zoneFlight = new SingleFlight<CfZone>();

  constructor(o: CloudflareOptions) {
    if (o.apiToken.trim() === "") {
      throw new AppError("unprocessable", "a Cloudflare API token is required for DNS-01");
    }
    this.#token = o.apiToken;
    this.#zoneId = o.zoneId !== undefined && o.zoneId !== "" ? o.zoneId : undefined;
    this.#fetch = o.fetch ?? ((url, init) => fetch(url, init));
    this.#base = (o.baseUrl ?? CLOUDFLARE_API).replace(/\/$/, "");
    this.#log = o.log ?? new Logger("info", { component: "tls/dns/cloudflare" });
    this.#dns = o.dns ?? nodeDnsQueries();
    this.#retry = { attempts: 5, baseMs: 500, maxMs: 30_000, ...o.retry };
    this.#propagationTimeoutMs = o.propagationTimeoutMs ?? 120_000;
    this.#propagationIntervalMs = o.propagationIntervalMs ?? 2_000;
  }

  /**
   * Adds a TXT record and returns Cloudflare's id for it.
   *
   * Adds, never updates. A wildcard order needs two TXT records with the same name and
   * different content (`*.preview.example.com` and `preview.example.com` are both answered at
   * `_acme-challenge.preview.example.com`). Updating an existing record destroys the other
   * authorization's value and fails one order in two, depending on validation order.
   *
   * The returned id is the reason cleanup is exact: deleting by id removes only what this
   * call made, where a search by name would sweep up the sibling record -- or somebody's
   * unrelated SPF/DKIM TXT at the same name.
   */
  async createTxt(name: string, value: string): Promise<{ recordId: string }> {
    const zone = await this.#zoneFor(name);
    const res = await this.#request<CfRecord>("POST", `/zones/${zone.id}/dns_records`, {
      type: "TXT",
      name,
      content: value,
      // 60s: the floor Cloudflare accepts on a non-enterprise zone, and it bounds how long
      // a stale negative answer can linger if something did query a recursive resolver.
      ttl: 60,
    });
    const id = res?.id;
    if (id === undefined || id === "") {
      throw internal("cloudflare created a TXT record but returned no id", {
        name,
        zone: zone.name,
      });
    }
    this.#log.info("created ACME TXT record", { name, recordId: id, zone: zone.name });
    return { recordId: id };
  }

  /**
   * Deletes by id. Idempotent: a record that is already gone is a success, because callers
   * run cleanup in a `finally` and a retried or duplicated cleanup must not mask the real
   * error from the order it is unwinding.
   */
  async removeTxt(recordId: string, name: string): Promise<void> {
    const zone = await this.#zoneFor(name);
    await this.#request<CfRecord>(
      "DELETE",
      `/zones/${zone.id}/dns_records/${encodeURIComponent(recordId)}`,
      undefined,
      {
        tolerateMissing: true,
      },
    );
    this.#log.info("removed ACME TXT record", { name, recordId, zone: zone.name });
  }

  /** Asks this zone's own authoritative nameservers; see provider.ts for why. */
  async waitForPropagation(name: string, expectedValues: string[]): Promise<boolean> {
    const zone = await this.#zoneFor(name);
    return await waitForTxtPropagation(name, expectedValues, {
      dns: this.#dns,
      zone: zone.name,
      log: this.#log,
      timeoutMs: this.#propagationTimeoutMs,
      intervalMs: this.#propagationIntervalMs,
    });
  }

  async #zoneFor(name: string): Promise<CfZone> {
    const cached = this.#zones.get(name);
    if (cached) return cached;
    // Singleflight because a wildcard order calls createTxt twice for the same name at once.
    return await this.#zoneFlight.run(name, async () => {
      const again = this.#zones.get(name);
      if (again) return again;
      const zone = await this.#lookupZone(name);
      this.#zones.set(name, zone);
      return zone;
    });
  }

  async #lookupZone(name: string): Promise<CfZone> {
    if (this.#zoneId !== undefined) {
      const zone = await this.#request<CfZone>("GET", `/zones/${encodeURIComponent(this.#zoneId)}`);
      if (!zone)
        throw notFound(`Cloudflare zone ${this.#zoneId} not found`, { zoneId: this.#zoneId });
      return { id: zone.id, name: zone.name };
    }

    const tried = zoneCandidates(name);
    for (const candidate of tried) {
      const zones = await this.#request<CfZone[]>(
        "GET",
        `/zones?name=${encodeURIComponent(candidate)}`,
      );
      const hit = zones?.[0];
      if (hit) {
        this.#log.debug("resolved Cloudflare zone", { name, zone: hit.name, zoneId: hit.id });
        return { id: hit.id, name: hit.name };
      }
    }
    throw notFound(`no Cloudflare zone covers ${name}`, { name, tried });
  }

  async #request<T>(
    method: string,
    path: string,
    body?: unknown,
    o: { tolerateMissing?: boolean } = {},
  ): Promise<T | null> {
    return await retry<T | null>(
      async () => {
        const res = await this.#fetch(`${this.#base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.#token}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

        // 429 is Cloudflare's global 1200-requests-per-five-minutes limit; 5xx is theirs to
        // fix. Both are worth waiting out rather than failing a certificate renewal.
        if (res.status === 429 || res.status >= 500) {
          const hinted = retryAfterMs(res.headers.get("retry-after"));
          if (hinted > 0) await sleep(Math.min(hinted, this.#retry.maxMs ?? 30_000));
          throw new AppError(
            res.status === 429 ? "rate_limited" : "bad_gateway",
            `cloudflare ${method} ${path} -> ${res.status}`,
            { status: res.status },
          );
        }

        const envelope = await readEnvelope<T>(res);
        const failed = res.status >= 400 || envelope.success === false;
        if (failed) {
          const errors = envelope.errors ?? [];
          if (
            o.tolerateMissing &&
            (res.status === 404 || errors.some((e) => e.code === RECORD_NOT_FOUND))
          ) {
            return null;
          }
          throw cloudflareError(method, path, res.status, errors);
        }
        return envelope.result ?? null;
      },
      {
        ...this.#retry,
        // Retry transport failures and Cloudflare's own overload; never a 4xx, which is a
        // bad token or a bad request and will fail identically five times.
        shouldRetry: (err) =>
          !(err instanceof AppError) || err.code === "rate_limited" || err.code === "bad_gateway",
        onRetry: (attempt, delayMs, err) =>
          this.#log.warn("retrying Cloudflare request", {
            method,
            path,
            attempt,
            delayMs,
            reason: errorMessage(err),
          }),
      },
    );
  }
}

/** `Retry-After` is seconds, or an HTTP date. Both appear in the wild. */
function retryAfterMs(header: string | null): number {
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? 0 : Math.max(0, at - Date.now());
}

async function readEnvelope<T>(res: Response): Promise<CfEnvelope<T>> {
  const text = await res.text().catch(() => "");
  if (text === "") return {};
  try {
    return JSON.parse(text) as CfEnvelope<T>;
  } catch {
    return { success: false, errors: [{ code: 0, message: text.slice(0, 200) }] };
  }
}

function cloudflareError(
  method: string,
  path: string,
  status: number,
  errors: CfError[],
): AppError {
  const detail = errors.map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${status}`;
  if (status === 401 || status === 403) {
    return new AppError(
      "forbidden",
      `cloudflare rejected the API token (${detail}); it needs Zone:DNS:Edit on the zone`,
      { status, method, path },
    );
  }
  return internal(`cloudflare ${method} ${path} failed: ${detail}`, { status, errors });
}
