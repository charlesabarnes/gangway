import { promises as dnsPromises } from "node:dns";
import { Resolver } from "node:dns/promises";
import { must } from "@gangway/shared/must";

export type Tunnel = {
  host: string;
  url: string;
  ended: Promise<void>;
  stop(): void;
};

/** Where a share comes from: Cloudflare quick tunnels today, a hosted relay later. */
export interface ShareProvider {
  readonly name: string;
  available(): boolean;
  open(o: { origin: string; signal?: AbortSignal }): Promise<Tunnel>;
}

type Spawned = {
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
};

export type TunnelSpawner = (argv: string[]) => Spawned;

const bunSpawner: TunnelSpawner = (argv) => {
  const proc = Bun.spawn({ cmd: argv, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  return {
    stderr: proc.stderr,
    exited: proc.exited,
    kill: () => {
      proc.kill();
    },
  };
};

const URL_RE = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)\b/;
// The hostname is printed before the edge knows it; a request before this line gets a 1033.
const READY_RE = /Registered tunnel connection/;
const TAIL = 20;

export type Resolves = (host: string) => Promise<boolean>;

// Asks trycloudflare.com's own nameservers, which cache nothing: 1.1.1.1, asked a second early,
// kept the miss for 45 s. A resolver per lookup, since c-ares caches misses too.
export function resolvesAtAuthority(zone = "trycloudflare.com"): Resolves {
  let servers: Promise<string[]> | null = null;
  const load = async () => {
    const names = await dnsPromises.resolveNs(zone);
    return (await Promise.all(names.map((n) => dnsPromises.resolve4(n)))).flat();
  };
  return async (host) => {
    try {
      servers ??= load().catch((e: unknown) => {
        servers = null;
        throw e;
      });
      const r = new Resolver({ timeout: 2_000, tries: 1 });
      r.setServers(await servers);
      return (await r.resolve4(host)).length > 0;
    } catch {
      return false;
    }
  };
}

export type QuickTunnelOptions = {
  binary: string;
  spawn?: TunnelSpawner;
  readyTimeoutMs?: number;
  resolves?: Resolves;
  dnsWaitMs?: number;
  dnsPollMs?: number;
};

/** `cloudflared tunnel --url`: no account, a random *.trycloudflare.com name each time, 200
 * requests at once and no server-sent events. Cloudflare says it is for testing. */
export class QuickTunnels implements ShareProvider {
  readonly name = "cloudflare-quick";
  readonly #binary: string;
  readonly #spawn: TunnelSpawner;
  readonly #readyTimeoutMs: number;
  readonly #resolves: Resolves;
  readonly #dnsWaitMs: number;
  readonly #dnsPollMs: number;
  #found: boolean | undefined;

  constructor(o: QuickTunnelOptions) {
    this.#binary = o.binary;
    this.#spawn = o.spawn ?? bunSpawner;
    this.#readyTimeoutMs = o.readyTimeoutMs ?? 30_000;
    this.#resolves = o.resolves ?? resolvesAtAuthority();
    this.#dnsWaitMs = o.dnsWaitMs ?? 45_000;
    this.#dnsPollMs = o.dnsPollMs ?? 1_000;
    if (o.spawn) {
      this.#found = true;
    }
  }

  available(): boolean {
    this.#found ??= Bun.which(this.#binary) !== null;
    return this.#found;
  }

  async open({ origin, signal }: { origin: string; signal?: AbortSignal }): Promise<Tunnel> {
    // --no-tls-verify: the listener's certificate is gangway's own, or names another host.
    const proc = this.#spawn([
      this.#binary,
      "tunnel",
      "--no-autoupdate",
      "--metrics",
      "127.0.0.1:0",
      "--no-tls-verify",
      "--url",
      origin,
    ]);
    const tail: string[] = [];
    let host: string | undefined;
    let settle: ((err?: Error) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      settle = (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };
    });
    const exited = proc.exited.then(() => undefined);

    void readLines(proc.stderr, (line) => {
      tail.push(line);
      if (tail.length > TAIL) {
        tail.shift();
      }
      host ??= URL_RE.exec(line)?.[1];
      if (host && READY_RE.test(line)) {
        settle?.();
      }
    });
    void exited.then(() => settle?.(failure("cloudflared exited before the tunnel was up", tail)));
    const timer = setTimeout(
      () => settle?.(failure(`no tunnel after ${this.#readyTimeoutMs / 1000} s`, tail)),
      this.#readyTimeoutMs,
    );
    const onAbort = () => settle?.(new Error("the share was cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await ready;
    } catch (e) {
      proc.kill();
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settle = undefined;
    }
    const name = must(host, "the tunnel's hostname");
    const exit = { gone: false };
    void exited.then(() => (exit.gone = true));
    // An early lookup is a miss the visitor's resolver keeps for a minute: wait until it resolves.
    const deadline = Date.now() + this.#dnsWaitMs;
    while (
      !exit.gone &&
      !signal?.aborted &&
      Date.now() < deadline &&
      !(await this.#resolves(name))
    ) {
      await Bun.sleep(this.#dnsPollMs);
    }
    if (exit.gone || signal?.aborted) {
      proc.kill();
      throw failure("cloudflared exited before its hostname was in DNS", tail);
    }
    return {
      host: name,
      url: `https://${name}`,
      ended: exited,
      stop: () => {
        proc.kill();
      },
    };
  }
}

function failure(what: string, tail: string[]): Error {
  const last = tail.findLast((l) => /\bERR\b|error/i.test(l)) ?? tail.at(-1);
  return new Error(last ? `${what}: ${last.trim()}` : what);
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    if (buf) {
      onLine(buf);
    }
  } catch {
    // The process was killed mid-read; its end is reported through exited.
  }
}

export function listenerOrigin(address: string, port: number): string {
  const host = address === "::" || address === "0.0.0.0" || address === "" ? "127.0.0.1" : address;
  const bracketed = host.includes(":") ? `[${host}]` : host;
  return `https://${bracketed}:${port}`;
}
