import { describe, expect, test } from "bun:test";
import { isLocalDomain } from "@gangway/shared/hostname";
import type { Actor } from "../../src/auth/actor.ts";
import { DomainsRepo, ProjectsRepo, RoutesRepo } from "../../src/db/repos/index.ts";
import { DomainRegistry } from "../../src/domains/registry.ts";
import { MemorySettingsStore, Settings } from "../../src/settings.ts";
import { urlsFor } from "../../src/previews/deploy-names.ts";
import { destroy } from "../../src/previews/destroy.ts";
import { shareStatus, startShare, stopShare } from "../../src/previews/share.ts";
import { RouteTable } from "../../src/routing/table.ts";
import { tunnelClientIp, tunnelPeerFor } from "../../src/share/client-ip.ts";
import { Shares, type ShareEnd } from "../../src/share/shares.ts";
import {
  listenerOrigin,
  QuickTunnels,
  type ShareProvider,
  type Tunnel,
  type TunnelSpawner,
} from "../../src/share/tunnels.ts";
import { tempDb } from "../helpers/db.ts";
import { seededHosts } from "../helpers/hosts.ts";
import { silentLogger } from "../helpers/logger.ts";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";

/** A process whose stderr is fed by hand and which ends when killed. */
function fakeProcess() {
  const enc = new TextEncoder();
  let push!: (line: string) => void;
  let close!: () => void;
  let exit!: (code: number) => void;
  const stderr = new ReadableStream<Uint8Array>({
    start(c) {
      push = (line) => c.enqueue(enc.encode(`${line}\n`));
      close = () => c.close();
    },
  });
  const exited = new Promise<number>((r) => (exit = r));
  const proc = {
    argv: [] as string[],
    killed: false,
    say: (line: string) => push(line),
    ended: false,
    end: (code = 1) => {
      if (proc.ended) {
        return;
      }
      proc.ended = true;
      close();
      exit(code);
    },
  };
  const spawn: TunnelSpawner = (argv) => {
    proc.argv = argv;
    return {
      stderr,
      exited,
      kill: () => {
        proc.killed = true;
        proc.end(143);
      },
    };
  };
  return { proc, spawn };
}

const URL_LINE =
  "2026-09-27T10:00:00Z INF |  https://cedar-lamp-quiet-river.trycloudflare.com                  |";
const READY_LINE =
  "2026-09-27T10:00:02Z INF Registered tunnel connection connIndex=0 location=iad08 protocol=quic";

describe("cloudflared quick tunnels", () => {
  test("waits for a registered connection, then gives the printed hostname", async () => {
    const { proc, spawn } = fakeProcess();
    const tunnels = new QuickTunnels({ binary: "cloudflared", spawn, resolves: async () => true });
    const opening = tunnels.open({ origin: "https://127.0.0.1:8443" });
    let done = false;
    void opening.then(() => (done = true));
    proc.say("2026-09-27T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...");
    proc.say(URL_LINE);
    await Bun.sleep(5);
    expect(done).toBe(false);
    proc.say(READY_LINE);
    const tunnel = await opening;
    expect(tunnel.host).toBe("cedar-lamp-quiet-river.trycloudflare.com");
    expect(tunnel.url).toBe("https://cedar-lamp-quiet-river.trycloudflare.com");
    expect(proc.argv).toEqual([
      "cloudflared",
      "tunnel",
      "--no-autoupdate",
      "--metrics",
      "127.0.0.1:0",
      "--no-tls-verify",
      "--url",
      "https://127.0.0.1:8443",
    ]);
    tunnel.stop();
    expect(proc.killed).toBe(true);
    await tunnel.ended;
  });

  test("an early exit fails with cloudflared's own last error", async () => {
    const { proc, spawn } = fakeProcess();
    const opening = new QuickTunnels({
      binary: "cloudflared",
      spawn,
      resolves: async () => true,
    }).open({ origin: "x" });
    proc.say('2026-09-27T10:00:00Z ERR failed to request quick Tunnel: 429 Too Many Requests"');
    proc.end(1);
    await expect(opening).rejects.toThrow(
      /exited before the tunnel was up: .*429 Too Many Requests/,
    );
  });

  test("gives up and kills the process when no tunnel comes up in time", async () => {
    const { proc, spawn } = fakeProcess();
    const tunnels = new QuickTunnels({
      binary: "cloudflared",
      spawn,
      readyTimeoutMs: 20,
      resolves: async () => true,
    });
    const opening = tunnels.open({ origin: "x" });
    proc.say(URL_LINE);
    await expect(opening).rejects.toThrow(/no tunnel after/);
    await opening.catch(() => {});
    expect(proc.killed).toBe(true);
  });

  test("hands the link out only once its hostname is in public DNS", async () => {
    const { proc, spawn } = fakeProcess();
    let lookups = 0;
    const tunnels = new QuickTunnels({
      binary: "cloudflared",
      spawn,
      dnsPollMs: 1,
      resolves: async (host) => {
        expect(host).toBe("cedar-lamp-quiet-river.trycloudflare.com");
        return ++lookups >= 3;
      },
    });
    const opening = tunnels.open({ origin: "x" });
    proc.say(URL_LINE);
    proc.say(READY_LINE);
    await opening;
    expect(lookups).toBe(3);
  });

  test("dials the listener on loopback when it listens everywhere", () => {
    expect(listenerOrigin("::", 8443)).toBe("https://127.0.0.1:8443");
    expect(listenerOrigin("0.0.0.0", 443)).toBe("https://127.0.0.1:443");
    expect(listenerOrigin("172.17.0.1", 8443)).toBe("https://172.17.0.1:8443");
    expect(listenerOrigin("fd00::1", 8443)).toBe("https://[fd00::1]:8443");
  });
});

/** A provider whose tunnels are made instantly and can be dropped by the test. */
function fakeProvider() {
  let n = 0;
  const open: { host: string; drop: () => void; stopped: boolean }[] = [];
  const provider: ShareProvider = {
    name: "fake",
    available: () => true,
    open: async () => {
      let end!: () => void;
      const ended = new Promise<void>((r) => (end = r));
      const t = { host: `t${++n}.trycloudflare.com`, drop: end, stopped: false };
      open.push(t);
      const tunnel: Tunnel = {
        host: t.host,
        url: `https://${t.host}`,
        ended,
        stop: () => {
          t.stopped = true;
          end();
        },
      };
      return tunnel;
    },
  };
  return { provider, open };
}

function shares(o: { enabled?: boolean; maxTtlMs?: number } = {}) {
  const { provider, open } = fakeProvider();
  let now = 1_000;
  const changes: [string, ShareEnd | null][] = [];
  const s = new Shares({
    provider,
    origin: "https://127.0.0.1:8443",
    enabled: () => o.enabled ?? true,
    maxTtlMs: () => o.maxTtlMs ?? 3_600_000,
    logger: silentLogger(),
    now: () => now,
    onChange: (share, end) => changes.push([share.previewId, end]),
  });
  return { s, open, changes, tick: (ms: number) => (now += ms) };
}

describe("shares", () => {
  test("one link per preview, found by its hostname, capped at the server's maximum", async () => {
    const { s, open } = shares();
    const [a, b] = await Promise.all([s.start("p1", 99 * 3_600_000), s.start("p1")]);
    expect(a).toEqual(b);
    expect(open).toHaveLength(1);
    expect(a).toMatchObject({ previewId: "p1", url: "https://t1.trycloudflare.com" });
    expect(a.expiresAt - a.startedAt).toBe(3_600_000);
    expect(s.target("t1.trycloudflare.com")).toBe("p1");
    expect(s.isShareHost("t1.trycloudflare.com")).toBe(true);
    expect(s.target("elsewhere.trycloudflare.com")).toBeUndefined();
  });

  test("stopping ends the tunnel and forgets the hostname; the first reason stands", async () => {
    const { s, open, changes } = shares();
    await s.start("p1");
    expect(s.stop("p1")?.host).toBe("t1.trycloudflare.com");
    await Bun.sleep(0);
    expect(open[0]!.stopped).toBe(true);
    expect(s.target("t1.trycloudflare.com")).toBeUndefined();
    expect(s.get("p1")).toBeUndefined();
    expect(changes).toEqual([
      ["p1", null],
      ["p1", "stopped"],
    ]);
    expect(s.stop("p1")).toBeUndefined();
  });

  test("a tunnel that drops on its own ends the share", async () => {
    const { s, open, changes } = shares();
    await s.start("p1");
    open[0]!.drop();
    await Bun.sleep(0);
    expect(s.get("p1")).toBeUndefined();
    expect(changes.at(-1)).toEqual(["p1", "dropped"]);
  });

  test("expiry ends only the shares past their time", async () => {
    const { s, tick } = shares();
    await s.start("p1", 60_000);
    await s.start("p2", 600_000);
    tick(120_000);
    expect(s.expire()).toBe(1);
    expect(s.list().map((x) => x.previewId)).toEqual(["p2"]);
    s.stopAll();
    expect(s.list()).toEqual([]);
  });

  test("switching sharing off ends the links already running", async () => {
    let on = true;
    const { provider } = fakeProvider();
    const s = new Shares({
      provider,
      origin: "x",
      enabled: () => on,
      maxTtlMs: () => 3_600_000,
      logger: silentLogger(),
    });
    await s.start("p1");
    expect(s.expire()).toBe(0);
    on = false;
    expect(s.expire()).toBe(1);
    expect(s.get("p1")).toBeUndefined();
  });

  test("available only when switched on and the provider can run", () => {
    expect(shares({ enabled: false }).s.available()).toBe(false);
    expect(shares().s.available()).toBe(true);
    const missing = new QuickTunnels({ binary: "gangway-no-such-cloudflared" });
    expect(missing.available()).toBe(false);
  });
});

describe("a share hostname in the route table", () => {
  test("reads through to the preview's primary route until the share ends", async () => {
    const { s } = shares();
    const { db } = tempDb();
    seededHosts(db);
    const table = new RouteTable(new RoutesRepo(db), (h) => s.target(h));
    db.run(
      "INSERT INTO previews (id, project, host_id, state, source_kind, source_json, visibility, created_at, updated_at) VALUES ('p1', 'gw-shop', 'local', 'awake', 'image', '{}', 'public', 1, 1)",
    );
    table.apply({
      route: {
        hostname: "shop.preview.localhost",
        previewId: "p1",
        service: "web",
        containerPort: 80,
        upstream: { host: "127.0.0.1", port: 31000 },
        primary: true,
        createdAt: new Date(),
      },
      hostId: "local",
      project: "gw-shop",
      visibility: "public",
      state: "awake",
    });
    const { host } = await s.start("p1");
    expect(table.lookup(host)).toMatchObject({
      hostname: host,
      previewId: "p1",
      upstreamPort: 31000,
    });
    s.stop("p1");
    expect(table.lookup(host)).toBeUndefined();
  });
});

describe("the visitor behind a share link", () => {
  test("only cloudflared's own connection is believed", () => {
    const peer = tunnelPeerFor("::");
    expect(peer("127.0.0.1")).toBe(true);
    expect(peer("::ffff:127.0.0.1")).toBe(true);
    expect(peer("::1")).toBe(true);
    expect(peer("192.168.1.20")).toBe(false);
    expect(tunnelPeerFor("172.17.0.1")("172.17.0.1")).toBe(true);
  });

  test("CF-Connecting-IP first, then the last X-Forwarded-For hop", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(tunnelClientIp(h({ "cf-connecting-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(tunnelClientIp(h({ "x-forwarded-for": "10.0.0.1, 198.51.100.4" }))).toBe("198.51.100.4");
    expect(tunnelClientIp(h({ "cf-connecting-ip": "nonsense" }))).toBeNull();
    expect(tunnelClientIp(h({}))).toBeNull();
  });
});

describe("sharing a preview", () => {
  function setup(o: { local?: boolean } = {}) {
    const t = setupPreviewContext();
    const sh = shares();
    t.ctx.shares = sh.s;
    const baseDomain = o.local === false ? "gw.example.com" : "preview.localhost";
    t.ctx.domains = new DomainRegistry({
      settings: new Settings({ baseDomain }, new MemorySettingsStore()),
      domains: new DomainsRepo(t.db),
      projects: new ProjectsRepo(t.db),
      pinned: [],
    });
    return { ...t, ...sh };
  }

  test("starts a link, lists it among the URLs, audits it once, and says it is local", async () => {
    const t = setup();
    const p = await t.deployed("shop");
    expect(shareStatus(t.ctx, p.id)).toMatchObject({ available: true, local: true, share: null });

    const share = await startShare(t.ctx, ACTOR, p.id, "30m");
    expect(share.expiresAt - share.startedAt).toBe(1_800_000);
    await startShare(t.ctx, ACTOR, p.id);
    expect(urlsFor(t.ctx, p.id).at(-1)).toEqual({
      service: urlsFor(t.ctx, p.id)[0]!.service,
      url: "https://t1.trycloudflare.com/",
      primary: false,
      share: true,
    });
    const audited = () =>
      t.db
        .query<{ action: string }>("SELECT action FROM audit WHERE action LIKE 'preview.%share'")
        .map((r) => r.action);
    expect(audited()).toEqual(["preview.share"]);

    expect(stopShare(t.ctx, ACTOR, p.id)?.url).toBe("https://t1.trycloudflare.com");
    expect(audited()).toEqual(["preview.share", "preview.unshare"]);
    expect(shareStatus(t.ctx, p.id).share).toBeNull();
    expect(shareStatus(setup({ local: false }).ctx, p.id).local).toBe(false);
  });

  test("destroying the preview ends its link", async () => {
    const t = setup();
    const p = await t.deployed("shop");
    await startShare(t.ctx, ACTOR, p.id);
    await destroy(t.ctx, p.id, ACTOR);
    expect(t.s.get(p.id)).toBeUndefined();
    expect(t.changes.at(-1)).toEqual([p.id, "destroyed"]);
  });

  test("needs previews.share and the right to change that preview", async () => {
    const t = setup();
    const p = await t.deployed("shop");
    const user = (permissions: string[]): Actor =>
      ({
        kind: "user",
        userId: "u-ada",
        roleId: "member",
        permissions: new Set(permissions),
        sessionId: "s",
      }) as Actor;
    await expect(startShare(t.ctx, user(["previews.update"]), p.id)).rejects.toThrow(
      /previews.share/,
    );
    await expect(
      startShare(t.ctx, user(["previews.share", "previews.update_own"]), p.id),
    ).rejects.toThrow(/deployed by someone else/);
    await startShare(t.ctx, user(["previews.share", "previews.update"]), p.id);
    expect(t.s.get(p.id)).toBeDefined();
  });

  test("refuses a bad duration, and a server that cannot share", async () => {
    const t = setup();
    const p = await t.deployed("shop");
    await expect(startShare(t.ctx, ACTOR, p.id, "forever")).rejects.toThrow(/not a duration/);
    t.ctx.shares = shares({ enabled: false }).s;
    await expect(startShare(t.ctx, ACTOR, p.id)).rejects.toMatchObject({ status: 503 });
  });
});

test("*.localhost is a local-only install", () => {
  expect(isLocalDomain("preview.localhost")).toBe(true);
  expect(isLocalDomain("localhost")).toBe(true);
  expect(isLocalDomain("Preview.Localhost.")).toBe(true);
  expect(isLocalDomain("preview.example.com")).toBe(false);
  expect(isLocalDomain("notlocalhost")).toBe(false);
});
