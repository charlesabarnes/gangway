/**
 * ACME over DNS-01: one wildcard certificate for the base domain (never per preview),
 * renewed on a timer, stored in SQLite.
 *
 * The order of operations is the whole file, and each step is there because skipping it
 * fails in production in a way a fake never shows:
 *
 *  1. Create every TXT record before completing any challenge. A wildcard order has two
 *     authorizations that validate at the same `_acme-challenge` name with different
 *     values. Both must be visible at once.
 *  2. Wait for propagation on the zone's authoritative servers before telling the CA to
 *     look. The CA looks once; a miss is a failed authorization and a rate-limit strike.
 *  3. Remove the records in a `finally`. A failed order must not leave stale values that
 *     the next attempt's propagation check would happily match.
 *  4. Store first, swap second. A certificate that exists only in memory is reissued on
 *     every restart, and Let's Encrypt allows 5 duplicates a week.
 *
 * The account key is persisted too: a new account per boot is its own rate limit.
 */
import acme from "acme-client";
import type { CertificatesRepo } from "../db/repos/certificates.ts";
import type { Logger } from "../logger.ts";
import type { SettingsStore } from "../settings.ts";
import type { DnsProvider } from "./dns/provider.ts";
import { RENEWAL_WINDOW_MS } from "./provider.ts";
import type { CertBundle, CertProvider } from "./types.ts";

/** The slice of acme-client's Client this file uses. The real Client satisfies it as is. */
export type AcmeApi = Pick<
  acme.Client,
  | "createAccount"
  | "getAccountUrl"
  | "createOrder"
  | "getAuthorizations"
  | "getChallengeKeyAuthorization"
  | "completeChallenge"
  | "waitForValidStatus"
  | "finalizeOrder"
  | "getCertificate"
>;

export type AcmeConnect = (o: {
  directoryUrl: string;
  accountKey: string;
  accountUrl?: string;
}) => AcmeApi;

export type AcmeOptions = {
  directoryUrl: string;
  /** Optional. Let's Encrypt no longer sends expiry mail, but other CAs use it. */
  email: string;
  dns: DnsProvider;
  certs: CertificatesRepo;
  /** Where the account key lives: the settings table, so one file is the whole backup. */
  store: SettingsStore;
  logger: Logger;
  now?: () => number;
  connect?: AcmeConnect;
};

type StoredAccount = { keyPem: string; url: string };
const ACCOUNTS_KEY = "acme.accounts";

const challengeName = (identifier: string) => `_acme-challenge.${identifier.replace(/^\*\./, "")}`;

export class AcmeProvider implements CertProvider {
  readonly name = "acme" as const;
  readonly #o: AcmeOptions;
  readonly #now: () => number;
  readonly #connect: AcmeConnect;

  constructor(o: AcmeOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
    this.#connect = o.connect ?? ((c) => new acme.Client(c));
  }

  /**
   * Due when less than a third of the lifetime remains, capped at 30 days. A fixed 30-day
   * window is wrong for anything but 90-day certificates: a 6-day one (Let's Encrypt's
   * short-lived profile) would be "due" from the moment it was issued and reordered every
   * hour, forever.
   */
  isDue(bundle: CertBundle, now = this.#now()): boolean {
    if (bundle.materials.length === 0) return true;
    return bundle.materials.some((m) => {
      if (!m.notAfter) return true;
      const lifetime = m.notBefore ? m.notAfter.getTime() - m.notBefore.getTime() : Infinity;
      return m.notAfter.getTime() - now < Math.min(RENEWAL_WINDOW_MS, lifetime / 3);
    });
  }

  /**
   * What is already in the database, if it is usable as is: issued by this directory,
   * covering these names, and not expired. (Due-for-renewal is still usable -- serve it
   * while the renewal runs.) Never touches the network, so boot can call it.
   */
  load(domains: string[]): CertBundle | null {
    const row = this.#o.certs.get(domains[0]!);
    if (
      !row ||
      row.source !== this.#o.directoryUrl ||
      !row.notAfter ||
      row.notAfter.getTime() <= this.#now()
    )
      return null;
    let covered: string[];
    try {
      const info = acme.crypto.readCertificateInfo(row.certPem);
      covered = [info.domains.commonName, ...info.domains.altNames];
    } catch {
      return null;
    }
    if (!domains.every((d) => covered.includes(d))) return null;
    return {
      materials: [
        {
          serverName: domains[0]!,
          key: row.keyPem,
          cert: row.certPem + (row.chainPem ?? ""),
          notBefore: row.notBefore ?? undefined,
          notAfter: row.notAfter,
          issuer: row.issuer ?? undefined,
        },
      ],
    };
  }

  async ensure(domains: string[], signal?: AbortSignal): Promise<CertBundle> {
    const stored = this.load(domains);
    return stored && !this.isDue(stored) ? stored : this.issue(domains, signal);
  }

  /** The renewal job: a new bundle if one was needed and obtained, else null. */
  async renewIfDue(domains: string[], signal?: AbortSignal): Promise<CertBundle | null> {
    const stored = this.load(domains);
    return stored && !this.isDue(stored) ? null : this.issue(domains, signal);
  }

  async #client(): Promise<AcmeApi> {
    const { directoryUrl, email, store, logger } = this.#o;
    const accounts = (store.get(ACCOUNTS_KEY) ?? {}) as Record<string, StoredAccount>;
    const known = accounts[directoryUrl];
    if (known)
      return this.#connect({ directoryUrl, accountKey: known.keyPem, accountUrl: known.url });

    const keyPem = (await acme.crypto.createPrivateEcdsaKey()).toString();
    const client = this.#connect({ directoryUrl, accountKey: keyPem });
    await client.createAccount({
      termsOfServiceAgreed: true,
      ...(email ? { contact: [`mailto:${email}`] } : {}),
    });
    store.set(ACCOUNTS_KEY, {
      ...accounts,
      [directoryUrl]: { keyPem, url: client.getAccountUrl() },
    });
    logger.info("acme account created", { directoryUrl });
    return client;
  }

  async issue(domains: string[], signal?: AbortSignal): Promise<CertBundle> {
    const { dns, certs, logger, directoryUrl } = this.#o;
    const began = this.#now();
    logger.info("acme order starting", { domains, directoryUrl });

    const client = await this.#client();
    const order = await client.createOrder({
      identifiers: domains.map((value) => ({ type: "dns", value })),
    });
    const authzs = await client.getAuthorizations(order);

    const created: { recordId: string; name: string }[] = [];
    try {
      // Step 1: every record, before any challenge.
      const pending: {
        authz: acme.Authorization;
        challenge: (typeof authzs)[number]["challenges"][number];
      }[] = [];
      const byName = new Map<string, string[]>();
      for (const authz of authzs) {
        if (authz.status === "valid") continue; // the CA remembers a recent validation
        const challenge = authz.challenges.find((c) => c.type === "dns-01");
        if (!challenge)
          throw new Error(`the CA offered no dns-01 challenge for ${authz.identifier.value}`);
        const name = challengeName(authz.identifier.value);
        const value = await client.getChallengeKeyAuthorization(challenge);
        signal?.throwIfAborted();
        created.push({ ...(await dns.createTxt(name, value)), name });
        byName.set(name, [...(byName.get(name) ?? []), value]);
        pending.push({ authz, challenge });
      }

      // Step 2: visible everywhere, or do not bother the CA.
      for (const [name, values] of byName) {
        signal?.throwIfAborted();
        if (!(await dns.waitForPropagation(name, values))) {
          throw new Error(
            `TXT records at ${name} did not propagate; the order was abandoned before the CA was asked to validate`,
          );
        }
      }

      for (const { authz, challenge } of pending) {
        signal?.throwIfAborted();
        await client.completeChallenge(challenge);
        await client.waitForValidStatus(challenge);
        logger.debug("acme authorization valid", {
          identifier: authz.identifier.value,
          wildcard: authz.wildcard === true,
        });
      }

      const [key, csr] = await acme.crypto.createCsr(
        { commonName: domains[0]!, altNames: domains },
        await acme.crypto.createPrivateEcdsaKey(),
      );
      const pem = await client.getCertificate(await client.finalizeOrder(order, csr));

      // Re-joined with explicit newlines: a chain glued END-to-BEGIN is a BAD_END_LINE in OpenSSL.
      const [leaf, ...chain] = acme.crypto.splitPemChain(pem).map((c) => `${c.trim()}\n`);
      if (!leaf) throw new Error("the CA returned an empty certificate chain");
      const info = acme.crypto.readCertificateInfo(leaf);
      const chainPem = chain.join("");

      // Step 4: durable before it is live.
      certs.put({
        domain: domains[0]!,
        certPem: leaf,
        keyPem: key.toString(),
        chainPem: chainPem || null,
        issuer: info.issuer.commonName,
        source: directoryUrl,
        notBefore: info.notBefore,
        notAfter: info.notAfter,
      });
      logger.info("acme certificate issued", {
        domains,
        issuer: info.issuer.commonName,
        notAfter: info.notAfter.toISOString(),
        ms: this.#now() - began,
      });
      return {
        materials: [
          {
            serverName: domains[0]!,
            key: key.toString(),
            cert: leaf + chainPem,
            notBefore: info.notBefore,
            notAfter: info.notAfter,
            issuer: info.issuer.commonName,
          },
        ],
      };
    } finally {
      // Step 3: remove the records.
      for (const r of created) {
        await dns
          .removeTxt(r.recordId, r.name)
          .catch((e) =>
            logger.warn("could not remove an acme TXT record", { name: r.name, err: e }),
          );
      }
    }
  }
}
