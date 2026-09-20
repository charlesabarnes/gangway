/**
 * Holds the current certificate material and notifies the listener when it changes.
 *
 * The swap MECHANISM lives in net/listener.ts, not here, because spike S0 found that
 * `server.reload({ tls })` does NOT swap the certificate on Bun 1.4.2 -- new connections
 * still presented the old serial. The listener therefore rebinds with SO_REUSEPORT and
 * drains the old listener (ADR-0002, measured 12-18ms). Isolating that here means the
 * day Bun fixes reload(), only the listener changes.
 */
import type { CertBundle } from "./types.ts";

export type CertListener = (bundle: CertBundle) => void | Promise<void>;

export class CertStore {
  #bundle: CertBundle;
  readonly #listeners = new Set<CertListener>();

  constructor(initial: CertBundle) {
    this.#bundle = initial;
  }

  current(): CertBundle {
    return this.#bundle;
  }

  /** The shape Bun.serve wants for `tls`. Every entry carries a serverName. */
  tlsConfig(): { serverName: string; cert: string; key: string }[] {
    return this.#bundle.materials.map((m) => ({ serverName: m.serverName, cert: m.cert, key: m.key }));
  }

  onSwap(fn: CertListener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  async swap(bundle: CertBundle): Promise<void> {
    if (bundle.materials.length === 0) {
      throw new Error("refusing to swap in an empty certificate bundle");
    }
    this.#bundle = bundle;
    for (const fn of this.#listeners) await fn(bundle);
  }

  /** Earliest expiry across the bundle -- the one that governs renewal. */
  earliestNotAfter(): Date | null {
    let earliest: Date | null = null;
    for (const m of this.#bundle.materials) {
      if (!m.notAfter) continue;
      if (!earliest || m.notAfter < earliest) earliest = m.notAfter;
    }
    return earliest;
  }
}
