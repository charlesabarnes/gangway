import type { Logger } from "../logger.ts";
import type { ShareProvider, Tunnel } from "./tunnels.ts";

export type Share = {
  previewId: string;
  url: string;
  host: string;
  provider: string;
  startedAt: number;
  expiresAt: number;
};

export type ShareEnd = "stopped" | "expired" | "disabled" | "destroyed" | "dropped" | "shutdown";

export type SharesOptions = {
  provider: ShareProvider;
  origin: string;
  enabled: () => boolean;
  maxTtlMs: () => number;
  logger: Logger;
  now?: () => number;
  /** Told when a share starts or ends, including one that dropped on its own. */
  onChange?: (share: Share, end: ShareEnd | null) => void;
};

type Live = Share & { tunnel: Tunnel };

/** One public link per preview, in memory: a restart ends every share. The link aliases the
 * preview's primary route, so its visibility and password still apply. */
export class Shares {
  readonly #o: SharesOptions;
  readonly #byPreview = new Map<string, Live>();
  readonly #byHost = new Map<string, Live>();
  readonly #starting = new Map<string, Promise<Share>>();
  readonly #now: () => number;

  constructor(o: SharesOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
  }

  get provider(): string {
    return this.#o.provider.name;
  }

  available(): boolean {
    return this.#o.enabled() && this.#o.provider.available();
  }

  maxTtlMs(): number {
    return this.#o.maxTtlMs();
  }

  target(host: string): string | undefined {
    return this.#byHost.get(host)?.previewId;
  }

  isShareHost(host: string): boolean {
    return this.#byHost.has(host);
  }

  get(previewId: string): Share | undefined {
    const live = this.#byPreview.get(previewId);
    return live ? view(live) : undefined;
  }

  list(): Share[] {
    return [...this.#byPreview.values()].map(view);
  }

  /** Starts a share, or returns the one already running (with its expiry moved, if asked). */
  async start(previewId: string, ttlMs?: number): Promise<Share> {
    const ttl = Math.min(ttlMs ?? this.maxTtlMs(), this.maxTtlMs());
    const live = this.#byPreview.get(previewId);
    if (live) {
      if (ttlMs !== undefined) {
        live.expiresAt = this.#now() + ttl;
      }
      return view(live);
    }
    const pending = this.#starting.get(previewId);
    if (pending) {
      return pending;
    }
    const p = this.#open(previewId, ttl).finally(() => this.#starting.delete(previewId));
    this.#starting.set(previewId, p);
    return p;
  }

  async #open(previewId: string, ttl: number): Promise<Share> {
    const tunnel = await this.#o.provider.open({ origin: this.#o.origin });
    const now = this.#now();
    const live: Live = {
      previewId,
      url: tunnel.url,
      host: tunnel.host,
      provider: this.#o.provider.name,
      startedAt: now,
      expiresAt: now + ttl,
      tunnel,
    };
    this.#byPreview.set(previewId, live);
    this.#byHost.set(live.host, live);
    this.#o.logger.info("preview shared", { previewId, url: live.url });
    this.#o.onChange?.(view(live), null);
    void tunnel.ended.then(() => this.#end(live, "dropped"));
    return view(live);
  }

  stop(previewId: string, why: ShareEnd = "stopped"): Share | undefined {
    const live = this.#byPreview.get(previewId);
    if (!live) {
      return undefined;
    }
    this.#end(live, why);
    return view(live);
  }

  /** Ends shares past their time, or every share once sharing is switched off; returns how many. */
  expire(): number {
    const now = this.#now();
    const on = this.#o.enabled();
    let n = 0;
    for (const live of [...this.#byPreview.values()]) {
      if (on && live.expiresAt > now) {
        continue;
      }
      this.#end(live, on ? "expired" : "disabled");
      n++;
    }
    return n;
  }

  stopAll(): void {
    for (const live of [...this.#byPreview.values()]) {
      this.#end(live, "shutdown");
    }
  }

  #end(live: Live, why: ShareEnd): void {
    // A tunnel that ends after being stopped reports "dropped" too; the first reason stands.
    if (this.#byPreview.get(live.previewId) !== live) {
      return;
    }
    this.#byPreview.delete(live.previewId);
    this.#byHost.delete(live.host);
    live.tunnel.stop();
    const fields = { previewId: live.previewId, why };
    if (why === "dropped") {
      this.#o.logger.warn("preview share ended", fields);
    } else {
      this.#o.logger.info("preview share ended", fields);
    }
    this.#o.onChange?.(view(live), why);
  }
}

function view(live: Live): Share {
  const { tunnel: _, ...share } = live;
  return share;
}
