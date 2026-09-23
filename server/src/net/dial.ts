import net from "node:net";
import type { UpstreamDial } from "@gangway/shared/domain";

export type DialTarget = { host: string; port: number };

export type DialConfig = {
  dial: UpstreamDial;
  proxy?: string | null | undefined;
  timeoutMs?: number;
};

const SOCKS_VERSION = 0x05;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;

const SOCKS_ERRORS: Record<number, string> = {
  1: "general SOCKS server failure",
  2: "connection not allowed by ruleset",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused",
  6: "TTL expired",
  7: "command not supported",
  8: "address type not supported",
};

export function parseSocksProxy(url: string): DialTarget {
  const u = new URL(url);
  if (u.protocol !== "socks5:" && u.protocol !== "socks:" && u.protocol !== "socks5h:") {
    throw new Error(`unsupported SOCKS proxy scheme: ${u.protocol}`);
  }
  return { host: u.hostname, port: Number(u.port || 1080) };
}

function connectTcp(target: DialTarget, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: target.host, port: target.port });
    const onError = (e: Error) => {
      socket.destroy();
      reject(e);
    };
    socket.setTimeout(timeoutMs, () =>
      onError(new Error(`connect timeout to ${target.host}:${target.port}`)),
    );
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.setTimeout(0);
      socket.removeListener("error", onError);
      resolve(socket);
    });
  });
}

// One listener for the whole handshake: a detached data listener does not pause the stream, so unshifted bytes are lost and OpenSSH's single-chunk reply hangs.
function handshakeReader(socket: net.Socket, timeoutMs: number) {
  let buffered: Buffer = Buffer.alloc(0);
  let failure: Error | null = null;
  let waiter: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;

  const pump = () => {
    if (!waiter) return;
    if (failure) {
      const w = waiter;
      waiter = null;
      w.reject(failure);
      return;
    }
    if (buffered.length < waiter.n) return;
    const w = waiter;
    waiter = null;
    const out = buffered.subarray(0, w.n);
    buffered = buffered.subarray(w.n);
    w.resolve(out);
  };
  const fail = (e: Error) => {
    failure ??= e;
    socket.destroy();
    pump();
  };

  const onData = (d: Buffer) => {
    buffered = Buffer.concat([buffered, d]);
    pump();
  };
  const onError = (e: Error) => fail(e);
  const onEnd = () => fail(new Error("SOCKS proxy closed the connection"));
  const timer = setTimeout(() => fail(new Error("SOCKS handshake timeout")), timeoutMs);
  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("end", onEnd);

  return {
    read(n: number): Promise<Buffer> {
      return new Promise((resolve, reject) => {
        waiter = { n, resolve, reject };
        pump();
      });
    },
    release(): void {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("end", onEnd);
      if (buffered.length > 0) socket.unshift(buffered);
    },
  };
}

async function socks5Connect(
  proxy: DialTarget,
  target: DialTarget,
  timeoutMs: number,
): Promise<net.Socket> {
  const socket = await connectTcp(proxy, timeoutMs);
  const reader = handshakeReader(socket, timeoutMs);

  socket.write(Buffer.from([SOCKS_VERSION, 0x01, 0x00]));
  const greeting = await reader.read(2);
  if (greeting[0] !== SOCKS_VERSION) {
    socket.destroy();
    throw new Error(`bad SOCKS version from proxy: ${greeting[0]}`);
  }
  if (greeting[1] !== 0x00) {
    socket.destroy();
    throw new Error("SOCKS proxy requires authentication, which is not supported");
  }

  const isIpv4 = net.isIPv4(target.host);
  const isIpv6 = net.isIPv6(target.host);
  let addr: Buffer;
  let atyp: number;
  if (isIpv4) {
    atyp = ATYP_IPV4;
    addr = Buffer.from(target.host.split(".").map(Number));
  } else if (isIpv6) {
    atyp = ATYP_IPV6;
    const parts = target.host.split(":");
    addr = Buffer.alloc(16);
    for (let i = 0; i < 8; i++) addr.writeUInt16BE(parseInt(parts[i] || "0", 16), i * 2);
  } else {
    atyp = ATYP_DOMAIN;
    const name = Buffer.from(target.host, "utf8");
    addr = Buffer.concat([Buffer.from([name.length]), name]);
  }
  const port = Buffer.alloc(2);
  port.writeUInt16BE(target.port);
  socket.write(Buffer.concat([Buffer.from([SOCKS_VERSION, CMD_CONNECT, 0x00, atyp]), addr, port]));

  const reply = await reader.read(4);
  if (reply[1] !== 0x00) {
    socket.destroy();
    throw new Error(
      `SOCKS CONNECT to ${target.host}:${target.port} failed: ${SOCKS_ERRORS[reply[1]!] ?? `code ${reply[1]}`}`,
    );
  }
  const boundAtyp = reply[3];
  const len =
    boundAtyp === ATYP_IPV4 ? 4 : boundAtyp === ATYP_IPV6 ? 16 : (await reader.read(1))[0]!;
  await reader.read(len + 2);
  reader.release();
  return socket;
}

export async function dialUpstream(target: DialTarget, cfg: DialConfig): Promise<net.Socket> {
  const timeoutMs = cfg.timeoutMs ?? 10_000;
  if (cfg.dial === "direct") return connectTcp(target, timeoutMs);
  if (!cfg.proxy) throw new Error('upstream dial is "socks5" but no proxy is configured');
  return socks5Connect(parseSocksProxy(cfg.proxy), target, timeoutMs);
}
