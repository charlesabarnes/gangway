import { Logger } from "../../logger.ts";
import {
  nodeDnsQueries,
  waitForTxtPropagation,
  type DnsProvider,
  type DnsQueries,
} from "./provider.ts";

export type ManualOptions = {
  log?: Logger;
  dns?: DnsQueries;
  timeoutMs?: number;
  intervalMs?: number;
};

export class ManualDnsProvider implements DnsProvider {
  readonly #log: Logger;
  readonly #dns: DnsQueries;
  readonly #timeoutMs: number;
  readonly #intervalMs: number;
  readonly #pending = new Map<string, { name: string; value: string }>();
  #seq = 0;

  constructor(o: ManualOptions = {}) {
    this.#log = o.log ?? new Logger("info", { component: "tls/dns/manual" });
    this.#dns = o.dns ?? nodeDnsQueries();
    this.#timeoutMs = o.timeoutMs ?? 600_000;
    this.#intervalMs = o.intervalMs ?? 2_000;
  }

  async createTxt(name: string, value: string): Promise<{ recordId: string }> {
    const recordId = `manual-${++this.#seq}`;
    this.#pending.set(recordId, { name, value });
    this.#log.info(
      `ACTION REQUIRED: add TXT ${name} = "${value}" (ttl 60), in ADDITION to any existing record at that name`,
      {
        provider: "manual",
        action: "add",
        type: "TXT",
        name,
        content: value,
        ttl: 60,
        recordId,
      },
    );
    return { recordId };
  }

  async removeTxt(recordId: string, name: string): Promise<void> {
    const pending = this.#pending.get(recordId);
    this.#pending.delete(recordId);
    this.#log.info(
      `cleanup: the TXT record ${name} = "${pending?.value ?? "(unknown)"}" can now be deleted`,
      {
        provider: "manual",
        action: "remove",
        type: "TXT",
        name,
        recordId,
      },
    );
  }

  waitForPropagation(name: string, expectedValues: string[]): Promise<boolean> {
    this.#log.info(
      `waiting for ${expectedValues.length} TXT value(s) at ${name} to appear on the zone's authoritative nameservers`,
      {
        provider: "manual",
        name,
      },
    );
    return waitForTxtPropagation(name, expectedValues, {
      dns: this.#dns,
      log: this.#log,
      timeoutMs: this.#timeoutMs,
      intervalMs: this.#intervalMs,
    });
  }
}
