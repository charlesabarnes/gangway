import acme from "acme-client";
import type { CertificatesRepo } from "../db/repos/certificates.ts";
import type { Logger } from "../logger.ts";
import type { SettingsStore } from "../settings.ts";
import type { DnsProvider } from "./dns/provider.ts";
import { RENEWAL_WINDOW_MS } from "./provider.ts";
import type { CertBundle, CertProvider } from "./types.ts";

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
  email: string;
  dns: DnsProvider;
  certs: CertificatesRepo;
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

  // A third of the lifetime, capped at 30 days, so short-lived certs are not reordered hourly.
  isDue(bundle: CertBundle, now = this.#now()): boolean {
    if (bundle.materials.length === 0) return true;
    return bundle.materials.some((m) => {
      if (!m.notAfter) return true;
      const lifetime = m.notBefore ? m.notAfter.getTime() - m.notBefore.getTime() : Infinity;
      return m.notAfter.getTime() - now < Math.min(RENEWAL_WINDOW_MS, lifetime / 3);
    });
  }

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
      // Every record before any challenge: both wildcard authorizations validate at one name.
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

      // The CA looks once, and a miss is a failed authorization and a rate-limit strike.
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

      // Stored before it goes live: a certificate only in memory is reissued on every restart.
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
      // Always removed, or the next attempt's propagation check matches stale values.
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
