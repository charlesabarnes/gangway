/**
 * How the proxy reaches a preview's published port.
 *
 * This is the one place dev and production differ, and it is exactly §3.2's Host record
 * doing its job: production dials the port directly on the same machine, while in
 * development gangway runs on a laptop and the containers are on a remote Docker host
 * whose ports are bound to ITS loopback. A single `ssh -D` SOCKS5 tunnel covers every
 * port, where `ssh -L` cannot forward a range and preview ports are dynamic.
 *
 * SOCKS5 CONNECT (RFC 1928, no-auth) is implemented here rather than pulled in as a
 * dependency: it is a ~60 line handshake, and §13 requires every dependency to be
 * addon-free.
 */
import net from "node:net";
import type { UpstreamDial } from "../../../shared/src/domain.ts";

export type DialTarget = { host: string; port: number };

export type DialConfig = {
  dial: UpstreamDial;
  /** socks5://127.0.0.1:1080 -- required when dial is "socks5". */
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

/**
 * Reads the SOCKS handshake through ONE listener that stays attached for the whole
 * exchange.
 *
 * The obvious shape -- attach a `data` listener per read, detach it, `unshift` any
 * surplus -- loses bytes: once a stream is flowing, detaching the last listener does not
 * pause it, so the pushed-back surplus is emitted to nobody before the next read
 * attaches. OpenSSH sends its whole 10-byte CONNECT reply in one chunk; read 4 of those
 * that way and the other 6 are gone, and the handshake hangs until it times out.
 */
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
    /** Hands the socket over. The caller attaches its own listeners in the same tick. */
    release(): void {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("end", onEnd);
      // HTTP and WebSocket clients speak first, so there is normally nothing here. If a
      // server-speaks-first protocol ever rides this, its opening bytes are not lost.
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

  // Greeting: version, one method, "no authentication".
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

  // CONNECT request.
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
    // Only fully-expanded addresses reach here in practice (we dial numeric hosts).
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
  // Consume the bound address so the stream starts at the tunnelled payload.
  const boundAtyp = reply[3];
  const len =
    boundAtyp === ATYP_IPV4 ? 4 : boundAtyp === ATYP_IPV6 ? 16 : (await reader.read(1))[0]!;
  await reader.read(len + 2);
  reader.release();
  return socket;
}

/** Returns a connected socket to the upstream, whichever transport the host uses. */
export async function dialUpstream(target: DialTarget, cfg: DialConfig): Promise<net.Socket> {
  const timeoutMs = cfg.timeoutMs ?? 10_000;
  if (cfg.dial === "direct") return connectTcp(target, timeoutMs);
  if (!cfg.proxy) throw new Error('upstream dial is "socks5" but no proxy is configured');
  return socks5Connect(parseSocksProxy(cfg.proxy), target, timeoutMs);
}
