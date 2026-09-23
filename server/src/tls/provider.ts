/**
 * Certificate providers. Selected by config (`tlsMode`), so dev and production differ by
 * one setting rather than by a code path.
 */
import { readFileSync } from "node:fs";
import type { CertBundle, CertMaterial, CertProvider } from "./types.ts";
import { issueLeaf, loadOrCreateCa } from "./selfsigned.ts";

/** Renew when less than this remains. 30 days is the Let's Encrypt convention. */
export const RENEWAL_WINDOW_MS = 30 * 86_400_000;

function dueBefore(bundle: CertBundle, now: number, windowMs: number): boolean {
  if (bundle.materials.length === 0) return true;
  return bundle.materials.some((m) => !m.notAfter || m.notAfter.getTime() - now < windowMs);
}

/**
 * Development: a stable local CA in the state dir plus a wildcard leaf. Zero setup --
 * no mkcert, no DNS provider, no Let's Encrypt round trip on every restart.
 */
export class SelfSignedProvider implements CertProvider {
  readonly name = "selfsigned" as const;
  readonly #stateDir: string;

  constructor(stateDir: string) {
    this.#stateDir = stateDir;
  }

  async ensure(domains: string[]): Promise<CertBundle> {
    const { ca, caPath } = await loadOrCreateCa(this.#stateDir);
    // One leaf covering every domain: the wildcard does not match the apex, so both
    // "*.preview.x" and "preview.x" must be present as SANs.
    const material = await issueLeaf(ca, domains);
    return { materials: [material], caPath };
  }

  isDue(bundle: CertBundle, now = Date.now()): boolean {
    return dueBefore(bundle, now, RENEWAL_WINDOW_MS);
  }
}

/** Operators with their own certificates, and the fixture path used by proxy tests. */
export class FileProvider implements CertProvider {
  readonly name = "file" as const;
  readonly #certPath: string;
  readonly #keyPath: string;

  constructor(certPath: string, keyPath: string) {
    this.#certPath = certPath;
    this.#keyPath = keyPath;
  }

  async ensure(domains: string[]): Promise<CertBundle> {
    const material: CertMaterial = {
      serverName: domains[0] ?? "*",
      cert: readFileSync(this.#certPath, "utf8"),
      key: readFileSync(this.#keyPath, "utf8"),
    };
    return { materials: [material] };
  }

  /** Never auto-renewed: the operator owns the lifecycle. */
  isDue(): boolean {
    return false;
  }
}
