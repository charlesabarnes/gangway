import type { Certificate } from "../../../../shared/src/domain.ts";
import type { Db } from "../types.ts";
import { fromDate, rowToCert, type CertRow } from "./mappers.ts";

/**
 * Certificates and the ACME account key live in SQLite so "back up gangway" is
 * "copy one file" (§7.1 of the plan / §13's single-image install story).
 */
export class CertificatesRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  get(domain: string): Certificate | undefined {
    const r = this.#db.get<CertRow>("SELECT * FROM certificates WHERE domain = $d", { d: domain });
    return r ? rowToCert(r) : undefined;
  }

  all(): Certificate[] {
    return this.#db.query<CertRow>("SELECT * FROM certificates ORDER BY domain").map(rowToCert);
  }

  put(c: Omit<Certificate, "updatedAt" | "source"> & { source?: string | null }): Certificate {
    this.#db.run(
      `INSERT INTO certificates (domain, cert_pem, key_pem, chain_pem, issuer, source, not_before, not_after, updated_at)
       VALUES ($d, $cert, $key, $chain, $issuer, $source, $nb, $na, $now)
       ON CONFLICT(domain) DO UPDATE SET
         cert_pem = excluded.cert_pem, key_pem = excluded.key_pem, chain_pem = excluded.chain_pem,
         issuer = excluded.issuer, source = excluded.source, not_before = excluded.not_before,
         not_after = excluded.not_after, updated_at = excluded.updated_at`,
      {
        d: c.domain, cert: c.certPem, key: c.keyPem, chain: c.chainPem,
        issuer: c.issuer, source: c.source ?? null, nb: fromDate(c.notBefore), na: fromDate(c.notAfter), now: this.#now(),
      },
    );
    return this.get(c.domain)!;
  }

  /** Renewal check: due when it expires inside the window, or is missing entirely. */
  isDueForRenewal(domain: string, windowMs: number, now: number = this.#now()): boolean {
    const c = this.get(domain);
    if (!c || !c.notAfter) return true;
    return c.notAfter.getTime() - now < windowMs;
  }
}
