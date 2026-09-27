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

  /** One entry per name; the first is also what a client that sends no SNI gets. */
  tlsConfig(): { serverName: string; cert: string; key: string }[] {
    return this.#bundle.materials.flatMap((m) =>
      (m.names ?? [m.serverName]).map((serverName) => ({ serverName, cert: m.cert, key: m.key })),
    );
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

  earliestNotAfter(): Date | null {
    let earliest: Date | null = null;
    for (const m of this.#bundle.materials) {
      if (!m.notAfter) continue;
      if (!earliest || m.notAfter < earliest) earliest = m.notAfter;
    }
    return earliest;
  }
}
