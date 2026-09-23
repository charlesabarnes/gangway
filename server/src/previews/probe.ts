/**
 * "Is anything actually answering HTTP on this route yet?"
 *
 * A container being `running` does not mean the app inside has bound its port, and a TCP
 * connect proves nothing: dockerd's userland proxy accepts the connection the instant
 * the container exists, then resets it. So the probe speaks just enough HTTP to see a
 * status line. Any status counts -- a 404 or a 500 is an app that is up -- unless a health
 * path is given (`x-gangway.health`): then only 2xx/3xx from that path does.
 *
 * Goes through dial.ts like the proxy does, so it tests the path real requests will take
 * (SOCKS5 in dev, direct in production).
 */
import type { Host, Route } from "@gangway/shared/domain";
import { dialUpstream } from "../net/dial.ts";

export type RouteProbe = (
  route: Pick<Route, "upstream" | "hostname">,
  host: Pick<Host, "upstream">,
  healthPath?: string,
) => Promise<boolean>;

export const httpProbe: RouteProbe = async (route, host, healthPath) => {
  let socket;
  try {
    socket = await dialUpstream(route.upstream, {
      dial: host.upstream.dial,
      proxy: host.upstream.proxy,
      timeoutMs: 3_000,
    });
  } catch {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 3_000);
    let head = "";
    socket.on("data", (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (!healthPath) {
        if (head.length >= 5) {
          clearTimeout(timer);
          finish(head.startsWith("HTTP/"));
        }
        return;
      }
      if (head.length >= 12 || !head.startsWith("HTTP/".slice(0, head.length))) {
        clearTimeout(timer);
        const status = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(head);
        finish(status !== null && Number(status[1]) < 400);
      }
    });
    socket.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      finish(false);
    });
    socket.write(
      `GET ${healthPath ?? "/"} HTTP/1.1\r\nHost: ${route.hostname}\r\nUser-Agent: gangway-probe\r\nConnection: close\r\n\r\n`,
    );
  });
};

/**
 * A path a caller may ask to have checked: absolute, printable, no spaces or CR/LF to smuggle a
 * header.
 */
export const CHECK_PATH = /^\/[\x21-\x7e]{0,199}$/;

export type StatusProbe = (
  route: Pick<Route, "upstream" | "hostname">,
  host: Pick<Host, "upstream">,
  path: string,
) => Promise<number | null>;

/**
 * The status line one GET of `path` gets, through the same dial as the proxy --
 * so a deploy can say "/ 200, /api/health 200, /missing 404" instead of an agent curling
 * each one after. Null: nothing answered in time.
 */
export const httpStatus: StatusProbe = async (route, host, path) => {
  if (!CHECK_PATH.test(path)) return null;
  let socket;
  try {
    socket = await dialUpstream(route.upstream, {
      dial: host.upstream.dial,
      proxy: host.upstream.proxy,
      timeoutMs: 3_000,
    });
  } catch {
    return null;
  }
  return new Promise<number | null>((resolve) => {
    const finish = (s: number | null) => {
      socket.destroy();
      resolve(s);
    };
    const timer = setTimeout(() => finish(null), 5_000);
    let head = "";
    socket.on("data", (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (head.length >= 12 || !head.startsWith("HTTP/".slice(0, head.length))) {
        clearTimeout(timer);
        const m = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(head);
        finish(m ? Number(m[1]) : null);
      }
    });
    socket.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      finish(null);
    });
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: ${route.hostname}\r\nUser-Agent: gangway-check\r\nConnection: close\r\n\r\n`,
    );
  });
};
