import type { Logger } from "../logger.ts";
import { errorMessage } from "../errors.ts";
import type { AcmeProvider } from "./acme.ts";
import { issueLeaf, type DevCa } from "./selfsigned.ts";
import { RENEWAL_WINDOW_MS } from "./provider.ts";
import type { CertBundle, CertMaterial, CertUnit } from "./types.ts";

export type CertManagerOptions = {
  mode: "acme" | "selfsigned";
  /** The certificates to hold now, in the order clients see them; the first is the default. */
  plan: () => CertUnit[];
  /** Signs a stand-in for a unit the CA has not answered yet, and every unit in selfsigned mode. */
  devCa: () => Promise<DevCa>;
  acme?: AcmeProvider | undefined;
  logger: Logger;
  now?: () => number;
  /** New orders per run, so one run never spends the CA's rate limit on a batch of claims. */
  maxOrdersPerRun?: number;
};

type Held = { material: CertMaterial; real: boolean };
type Failure = { at: number; count: number; error: string };

export type CertUnitStatus = {
  names: string[];
  /** false while a dev-CA stand-in serves until the CA issues the real one. */
  issued: boolean;
  notAfter: Date | null;
  lastError: string | null;
};

const BACKOFF_MS = 3_600_000;
const MAX_BACKOFF_MS = 24 * 3_600_000;
const keyOf = (u: CertUnit) => u.names[0]!;

/** One certificate per unit, by SNI; a failing unit backs off alone, an hour up to a day. */
export class CertManager {
  readonly #o: CertManagerOptions;
  readonly #now: () => number;
  readonly #held = new Map<string, Held>();
  readonly #failures = new Map<string, Failure>();

  constructor(o: CertManagerOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
  }

  /** What to serve at boot: stored certificates where there are any, stand-ins elsewhere. */
  async start(): Promise<CertBundle> {
    for (const unit of this.#o.plan()) {
      const stored = this.#o.mode === "acme" ? this.#o.acme?.load(unit.names) : null;
      const material = stored?.materials[0];
      if (material) {
        this.#held.set(keyOf(unit), { material, real: true });
      } else {
        await this.#standIn(unit);
      }
    }
    if (this.#o.mode === "acme") {
      const waiting = this.status().filter((s) => !s.issued);
      if (waiting.length > 0) {
        this.#o.logger.warn("serving the dev CA until the CA issues these certificates", {
          names: waiting.map((s) => s.names[0]),
        });
      }
    }
    return this.bundle();
  }

  /** Brings the held certificates in line with the plan; the new bundle when anything changed. */
  async refresh(signal?: AbortSignal): Promise<CertBundle | null> {
    const units = this.#o.plan();
    const wanted = new Set(units.map(keyOf));
    let changed = false;
    for (const key of this.#held.keys()) {
      if (!wanted.has(key)) {
        this.#held.delete(key);
        this.#failures.delete(key);
        changed = true;
      }
    }
    let orders = 0;
    for (const unit of units) {
      if (signal?.aborted) {
        break;
      }
      const held = this.#held.get(keyOf(unit));
      if (!held) {
        await this.#standIn(unit);
        changed = true;
      }
      if (this.#o.mode === "selfsigned") {
        if (held && this.#due(held)) {
          await this.#standIn(unit);
          changed = true;
        }
        continue;
      }
      const current = this.#held.get(keyOf(unit))!;
      if (current.real && !this.#due(current)) {
        continue;
      }
      if (this.#backingOff(keyOf(unit))) {
        continue;
      }
      if (orders >= (this.#o.maxOrdersPerRun ?? 5)) {
        continue;
      }
      orders++;
      if (await this.#order(unit, signal)) {
        changed = true;
      }
    }
    return changed ? this.bundle() : null;
  }

  bundle(): CertBundle {
    const materials = this.#o
      .plan()
      .map((u) => this.#held.get(keyOf(u))?.material)
      .filter((m): m is CertMaterial => m !== undefined);
    return { materials };
  }

  status(): CertUnitStatus[] {
    return this.#o.plan().map((u) => {
      const held = this.#held.get(keyOf(u));
      return {
        names: u.names,
        issued: held?.real ?? false,
        notAfter: held?.material.notAfter ?? null,
        lastError: this.#failures.get(keyOf(u))?.error ?? null,
      };
    });
  }

  async #order(unit: CertUnit, signal?: AbortSignal): Promise<boolean> {
    const key = keyOf(unit);
    try {
      const bundle = await this.#o.acme!.ensure(unit.names, signal, { delegate: unit.delegate });
      const material = bundle.materials[0]!;
      this.#held.set(key, { material, real: true });
      this.#failures.delete(key);
      return true;
    } catch (e) {
      if (signal?.aborted) {
        return false;
      }
      const prior = this.#failures.get(key);
      const failure = { at: this.#now(), count: (prior?.count ?? 0) + 1, error: errorMessage(e) };
      this.#failures.set(key, failure);
      this.#o.logger.warn("certificate order failed; will try again", {
        names: unit.names,
        attempt: failure.count,
        err: e,
      });
      return false;
    }
  }

  #backingOff(key: string): boolean {
    const f = this.#failures.get(key);
    if (!f) {
      return false;
    }
    const wait = Math.min(MAX_BACKOFF_MS, BACKOFF_MS * 2 ** (f.count - 1));
    return this.#now() - f.at < wait;
  }

  #due(held: Held): boolean {
    const m = held.material;
    if (this.#o.mode === "acme") {
      return this.#o.acme!.isDue({ materials: [m] }, this.#now());
    }
    return !m.notAfter || m.notAfter.getTime() - this.#now() < RENEWAL_WINDOW_MS;
  }

  async #standIn(unit: CertUnit): Promise<void> {
    const material = await issueLeaf(await this.#o.devCa(), unit.names);
    this.#held.set(keyOf(unit), { material, real: this.#o.mode === "selfsigned" });
  }
}
