import { readFileSync } from "node:fs";
import type { CertBundle, CertMaterial, CertProvider } from "./types.ts";
import { issueLeaf, loadOrCreateCa } from "./selfsigned.ts";

export const RENEWAL_WINDOW_MS = 30 * 86_400_000;

function dueBefore(bundle: CertBundle, now: number, windowMs: number): boolean {
  if (bundle.materials.length === 0) return true;
  return bundle.materials.some((m) => !m.notAfter || m.notAfter.getTime() - now < windowMs);
}

export class SelfSignedProvider implements CertProvider {
  readonly name = "selfsigned" as const;
  readonly #stateDir: string;

  constructor(stateDir: string) {
    this.#stateDir = stateDir;
  }

  async ensure(domains: string[]): Promise<CertBundle> {
    const { ca, caPath } = await loadOrCreateCa(this.#stateDir);
    // The wildcard does not match the apex, so both names must be SANs.
    const material = await issueLeaf(ca, domains);
    return { materials: [material], caPath };
  }

  isDue(bundle: CertBundle, now = Date.now()): boolean {
    return dueBefore(bundle, now, RENEWAL_WINDOW_MS);
  }
}

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

  isDue(): boolean {
    return false;
  }
}
