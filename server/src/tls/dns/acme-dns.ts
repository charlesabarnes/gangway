import { AppError, errorMessage, internal } from "../../errors.ts";
import { Logger } from "../../logger.ts";
import { retry, type BackoffOptions } from "../../util/async.ts";
import type { FetchLike } from "./cloudflare.ts";
import {
  nodeDnsQueries,
  waitForTxtPropagation,
  type DnsProvider,
  type DnsQueries,
} from "./provider.ts";

// A CNAME chain longer than this is a loop or a mistake, not a delegation.
const MAX_CNAME_HOPS = 8;

export type AcmeDnsOptions = {
  url: string;
  username: string;
  password: string;
  subdomain: string;
  fetch?: FetchLike;
  log?: Logger;
  dns?: DnsQueries;
  retry?: BackoffOptions;
  propagationTimeoutMs?: number;
  propagationIntervalMs?: number;
};

/**
 * DNS-01 through acme-dns (github.com/joohoi/acme-dns): every challenge name is a CNAME to the
 * account's one name, which keeps the two latest values, enough for a wildcard and its apex.
 */
export class AcmeDnsProvider implements DnsProvider {
  readonly #url: string;
  readonly #username: string;
  readonly #password: string;
  readonly #subdomain: string;
  readonly #fetch: FetchLike;
  readonly #log: Logger;
  readonly #dns: DnsQueries;
  readonly #retry: BackoffOptions;
  readonly #propagationTimeoutMs: number;
  readonly #propagationIntervalMs: number;
  #seq = 0;

  constructor(o: AcmeDnsOptions) {
    for (const [field, value] of [
      ["URL", o.url],
      ["username", o.username],
      ["password", o.password],
      ["subdomain", o.subdomain],
    ] as const) {
      if (value.trim() === "") {
        throw new AppError("unprocessable", `acme-dns needs a ${field}`);
      }
    }
    let url = o.url;
    while (url.endsWith("/")) {
      url = url.slice(0, -1);
    }
    this.#url = url;
    this.#username = o.username;
    this.#password = o.password;
    this.#subdomain = o.subdomain.toLowerCase();
    this.#fetch = o.fetch ?? ((url, init) => fetch(url, init));
    this.#log = o.log ?? new Logger("info", { component: "tls/dns/acme-dns" });
    this.#dns = o.dns ?? nodeDnsQueries();
    this.#retry = { attempts: 5, baseMs: 500, maxMs: 30_000, ...o.retry };
    this.#propagationTimeoutMs = o.propagationTimeoutMs ?? 120_000;
    this.#propagationIntervalMs = o.propagationIntervalMs ?? 2_000;
  }

  // The value goes to the account's own name; the check first makes sure `name` leads there.
  async createTxt(name: string, value: string): Promise<{ recordId: string }> {
    await this.#target(name);
    await this.#update(value);
    this.#log.info("set ACME TXT record through acme-dns", { name, subdomain: this.#subdomain });
    return { recordId: `acme-dns-${++this.#seq}` };
  }

  async removeTxt(): Promise<void> {
    // acme-dns has no delete: the next order's two values replace these.
  }

  async waitForPropagation(name: string, expectedValues: string[]): Promise<boolean> {
    return waitForTxtPropagation(await this.#target(name), expectedValues, {
      dns: this.#dns,
      log: this.#log,
      timeoutMs: this.#propagationTimeoutMs,
      intervalMs: this.#propagationIntervalMs,
    });
  }

  async #target(name: string): Promise<string> {
    let current = name.replace(/\.$/, "").toLowerCase();
    for (let hop = 0; hop < MAX_CNAME_HOPS; hop++) {
      const next = (await this.#dns.resolveCname(current).catch(() => [] as string[]))[0];
      if (next === undefined) {
        break;
      }
      current = next.replace(/\.$/, "").toLowerCase();
    }
    if (!current.startsWith(`${this.#subdomain}.`)) {
      throw new AppError(
        "unprocessable",
        `${name} is not delegated to acme-dns: add a CNAME from ${name} to ${this.#subdomain}.<your acme-dns domain>`,
        { name, reached: current },
      );
    }
    return current;
  }

  async #update(txt: string): Promise<void> {
    const path = "/update";
    await retry(
      async () => {
        const res = await this.#fetch(`${this.#url}${path}`, {
          method: "POST",
          headers: {
            "x-api-user": this.#username,
            "x-api-key": this.#password,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ subdomain: this.#subdomain, txt }),
        });
        if (res.ok) {
          return;
        }
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        if (res.status === 429 || res.status >= 500) {
          throw new AppError(
            res.status === 429 ? "rate_limited" : "bad_gateway",
            `acme-dns POST ${path} -> ${res.status}`,
            { status: res.status },
          );
        }
        if (res.status === 401 || res.status === 403) {
          throw new AppError(
            "forbidden",
            `acme-dns rejected the account for ${this.#subdomain} (${res.status}); check GANGWAY_ACME_DNS_USERNAME and GANGWAY_ACME_DNS_PASSWORD`,
            { status: res.status },
          );
        }
        throw internal(`acme-dns POST ${path} failed: ${res.status} ${detail}`.trim(), {
          status: res.status,
        });
      },
      {
        ...this.#retry,
        shouldRetry: (err) =>
          !(err instanceof AppError) || err.code === "rate_limited" || err.code === "bad_gateway",
        onRetry: (attempt, delayMs, err) => {
          this.#log.warn("retrying acme-dns update", {
            attempt,
            delayMs,
            reason: errorMessage(err),
          });
        },
      },
    );
  }
}
