/**
 * The SOCKS5 client, against a real (tiny) SOCKS5 server on a real socket.
 *
 * `ssh -D` sends its 10-byte CONNECT reply in one chunk, so the client must not drop the bytes
 * after the first 4. The `chunking: "whole"` cases pin that.
 */
import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { dialUpstream, parseSocksProxy } from "../../src/net/dial.ts";

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

type ProxyOptions = {
  chunking: "whole" | "bytewise";
  reply?: number;
  method?: number;
  early?: string;
  stall?: boolean;
};

/** A SOCKS5 server that CONNECTs for real, so the tunnel can be exercised end to end. */
function socksProxy(
  o: ProxyOptions,
): Promise<{ url: string; requests: { atyp: number; host: string; port: number }[] }> {
  const requests: { atyp: number; host: string; port: number }[] = [];
  const send = async (s: net.Socket, b: Buffer) => {
    if (o.chunking === "whole") {
      s.write(b);
      return;
    }
    for (const byte of b) {
      s.write(Buffer.from([byte]));
      await Bun.sleep(1);
    }
  };
  const server = net.createServer((client) => {
    let buf = Buffer.alloc(0);
    let stage: "greeting" | "request" | "tunnel" = "greeting";
    client.on("error", () => {});
    client.on("data", async (d: Buffer) => {
      if (stage === "tunnel") return;
      buf = Buffer.concat([buf, d]);
      if (stage === "greeting" && buf.length >= 3) {
        buf = buf.subarray(2 + buf[1]!);
        stage = "request";
        if (o.stall) return;
        await send(client, Buffer.from([0x05, o.method ?? 0x00]));
      }
      if (stage === "request" && buf.length >= 7) {
        const atyp = buf[3]!;
        const alen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : 1 + buf[4]!;
        if (buf.length < 4 + alen + 2) return;
        const raw = buf.subarray(4, 4 + alen);
        const host =
          atyp === 0x01 ? [...raw].join(".") : atyp === 0x03 ? raw.subarray(1).toString() : "::1";
        const port = buf.readUInt16BE(4 + alen);
        requests.push({ atyp, host, port });
        stage = "tunnel";
        if (o.reply) {
          await send(client, Buffer.from([0x05, o.reply, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          client.end();
          return;
        }
        const upstream = net.connect({ host: atyp === 0x03 ? "127.0.0.1" : host, port });
        upstream.on("error", () => client.destroy());
        upstream.once("connect", async () => {
          // Exactly what OpenSSH sends: VER REP RSV ATYP=IPv4 0.0.0.0 port 0 -- ten bytes.
          const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
          // Inbound first: the client may speak the instant it has the last reply byte.
          client.pipe(upstream);
          await send(client, o.early ? Buffer.concat([reply, Buffer.from(o.early)]) : reply);
          upstream.pipe(client);
        });
      }
    });
  });
  closers.push(() => server.close());
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `socks5://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
        requests,
      });
    }),
  );
}

function echoServer(): Promise<number> {
  const server = net.createServer((s) => {
    s.on("error", () => {});
    s.on("data", (d) => s.write(`echo:${d.toString()}`));
  });
  closers.push(() => server.close());
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)),
  );
}

const roundTrip = (s: net.Socket, text: string) =>
  new Promise<string>((resolve, reject) => {
    s.once("data", (d) => resolve(d.toString()));
    s.once("error", reject);
    s.write(text);
  });

describe("SOCKS5 dial", () => {
  for (const chunking of ["whole", "bytewise"] as const) {
    test(`tunnels end to end when the proxy replies ${chunking === "whole" ? "in one chunk, as OpenSSH does" : "one byte at a time"}`, async () => {
      const port = await echoServer();
      const proxy = await socksProxy({ chunking });
      const s = await dialUpstream(
        { host: "127.0.0.1", port },
        { dial: "socks5", proxy: proxy.url, timeoutMs: 1_000 },
      );
      closers.push(() => s.destroy());
      expect(await roundTrip(s, "hello")).toBe("echo:hello");
      expect(await roundTrip(s, "again")).toBe("echo:again");
      expect(proxy.requests).toEqual([{ atyp: 0x01, host: "127.0.0.1", port }]);
    });
  }

  test("many dials in a row all succeed (the agent does this under load)", async () => {
    const port = await echoServer();
    const proxy = await socksProxy({ chunking: "whole" });
    const replies = await Promise.all(
      Array.from({ length: 25 }, async (_, i) => {
        const s = await dialUpstream(
          { host: "127.0.0.1", port },
          { dial: "socks5", proxy: proxy.url, timeoutMs: 2_000 },
        );
        const out = await roundTrip(s, `n${i}`);
        s.destroy();
        return out;
      }),
    );
    expect(replies).toEqual(Array.from({ length: 25 }, (_, i) => `echo:n${i}`));
  });

  test("a hostname is sent as a DOMAIN address, for the proxy to resolve on the far side", async () => {
    const port = await echoServer();
    const proxy = await socksProxy({ chunking: "whole" });
    const s = await dialUpstream(
      { host: "docker-host.internal", port },
      { dial: "socks5", proxy: proxy.url, timeoutMs: 1_000 },
    );
    closers.push(() => s.destroy());
    expect(proxy.requests).toEqual([{ atyp: 0x03, host: "docker-host.internal", port }]);
  });

  test("bytes that arrive glued to the reply belong to the tunnel and are not lost", async () => {
    const port = await echoServer();
    const proxy = await socksProxy({ chunking: "whole", early: "BANNER" });
    const s = await dialUpstream(
      { host: "127.0.0.1", port },
      { dial: "socks5", proxy: proxy.url, timeoutMs: 1_000 },
    );
    closers.push(() => s.destroy());
    const first = await new Promise<string>((resolve) =>
      s.once("data", (d) => resolve(d.toString())),
    );
    expect(first).toBe("BANNER");
  });

  test("a refused CONNECT says why", async () => {
    const proxy = await socksProxy({ chunking: "whole", reply: 0x05 });
    await expect(
      dialUpstream(
        { host: "127.0.0.1", port: 9 },
        { dial: "socks5", proxy: proxy.url, timeoutMs: 1_000 },
      ),
    ).rejects.toThrow(/SOCKS CONNECT to 127\.0\.0\.1:9 failed: connection refused/);
  });

  test("a proxy that demands authentication is refused, not hung on", async () => {
    const proxy = await socksProxy({ chunking: "whole", method: 0xff });
    await expect(
      dialUpstream(
        { host: "127.0.0.1", port: 9 },
        { dial: "socks5", proxy: proxy.url, timeoutMs: 1_000 },
      ),
    ).rejects.toThrow(/requires authentication/);
  });

  test("a proxy that never answers times out instead of holding the request forever", async () => {
    const proxy = await socksProxy({ chunking: "whole", stall: true });
    const started = Date.now();
    await expect(
      dialUpstream(
        { host: "127.0.0.1", port: 9 },
        { dial: "socks5", proxy: proxy.url, timeoutMs: 150 },
      ),
    ).rejects.toThrow(/SOCKS handshake timeout/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("proxy down: the dial fails fast", async () => {
    await expect(
      dialUpstream(
        { host: "127.0.0.1", port: 9 },
        { dial: "socks5", proxy: "socks5://127.0.0.1:1", timeoutMs: 1_000 },
      ),
    ).rejects.toThrow();
    await expect(dialUpstream({ host: "127.0.0.1", port: 9 }, { dial: "socks5" })).rejects.toThrow(
      /no proxy is configured/,
    );
  });

  test("parseSocksProxy", () => {
    expect(parseSocksProxy("socks5://127.0.0.1:1080")).toEqual({ host: "127.0.0.1", port: 1080 });
    expect(parseSocksProxy("socks5h://docker-host")).toEqual({ host: "docker-host", port: 1080 });
    expect(() => parseSocksProxy("http://127.0.0.1:1080")).toThrow(/unsupported/);
  });
});
