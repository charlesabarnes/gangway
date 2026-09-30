import { surfaceHandler } from "../app/app.ts";
import type { Config } from "../config.ts";
import type { Hooks } from "../forge/hooks.ts";
import type { Logger } from "../logger.ts";
import { hostKind, type DispatchDeps, type Surface } from "../net/dispatch.ts";
import { tlsAsk, type TlsAsk } from "../net/tls-ask.ts";
import { RequestRates } from "../net/rates.ts";
import { failedPage, wakingPage } from "../net/error-pages.ts";
import { DEFAULT_LIMITS } from "../net/limits.ts";
import { controlAllowRisk, controlGate } from "../net/control-allow.ts";
import { clientIpOf, startListener, type RunningListener } from "../net/listener.ts";
import { clientIpResolver, type ClientIpResolver } from "../net/trusted-proxy.ts";
import { serveSite, THEME_LOGO_PATH } from "../net/site.ts";
import { markScript } from "../net/watermark.ts";
import { useFontHostFor } from "../net/page-chrome.ts";
import { normalizeHost } from "@gangway/shared/hostname";
import { tunnelClientIp, tunnelPeerFor } from "../share/client-ip.ts";
import { NodeHttpUpstream, PerHostUpstream } from "../net/upstream.ts";
import { renderDist } from "../previews/artifact-render.ts";
import type { PreviewContext } from "../previews/context.ts";
import { Waker } from "../previews/sleep.ts";
import { SETTINGS, type Settings } from "../settings.ts";
import { CertStore } from "../tls/certstore.ts";
import type { CertBundle } from "../tls/types.ts";
import { sleep } from "../util/async.ts";
import type { Http } from "./http.ts";
import { serveKitFont } from "../app/kit-fonts.ts";

export type NetworkDeps = {
  config: Config;
  ctx: PreviewContext;
  surfaceEnabled: (s: Surface) => boolean;
  http: Http;
  hooks: Hooks;
  bundle: CertBundle;
  logger: Logger;
  baseDomain: () => string;
  settings: Settings;
};

export type Network = {
  listener: RunningListener;
  rates: RequestRates;
  redirect: ReturnType<typeof Bun.serve> | null;
  certStore: CertStore;
};

export function surfaceEnabledBy(settings: Settings): (s: Surface) => boolean {
  return (s) => {
    if (s === "app") {
      return settings.get(SETTINGS.surfacesUi);
    }
    if (s === "mcp") {
      return settings.get(SETTINGS.surfacesMcp);
    }
    return true;
  };
}

export function startNetwork(d: NetworkDeps): Network {
  const { config, logger } = d;
  // Throws at boot so a typo can't silently mean trust nobody.
  const resolveClientIp = clientIpResolver(config.trustedProxies);
  if (config.trustedProxies.length > 0) {
    logger.info("trusting X-Forwarded-For from reverse proxies", {
      trustedProxies: config.trustedProxies,
    });
  }

  const gate = controlGate(config.controlAllow);
  if (gate) {
    logger.info("the UI and API answer only these networks", {
      controlAllow: config.controlAllow,
    });
  }
  const risk = controlAllowRisk(config.controlAllow, config.trustedProxies);
  if (risk) {
    logger.warn(risk);
  }

  const { domains, shares } = d.ctx;
  // A custom or share hostname has no gangway apex above it to load fonts from.
  useFontHostFor(
    domains
      ? (host) =>
          domains.aliasTarget(host) || shares?.isShareHost(host)
            ? `app.${domains.control()}`
            : undefined
      : undefined,
  );
  const certStore = new CertStore(d.bundle);
  const rates = new RequestRates(
    () => ({
      perClient: d.settings.get(SETTINGS.limitsRequestsClient),
      perPreview: d.settings.get(SETTINGS.limitsRequestsPreview),
      socketsPerClient: d.settings.get(SETTINGS.limitsSocketsClient),
    }),
    {
      report: (refused) =>
        logger.warn("refused preview requests over the rate limits", { refused }),
    },
  );
  const deps = { ...dispatchDeps(d, resolveClientIp, gate ?? undefined), rates };
  const listener = startListener({
    hostname: config.listenAddress,
    port: config.listenPort,
    maxRequestBodySize: config.maxBodyBytes,
    idleTimeout: 120,
    certStore,
    deps,
    onError: (e) => logger.error("listener error", { err: e }),
  });
  const ask = tlsAsk({ trustedProxies: config.trustedProxies, answers: answersFor(deps) });
  return { listener, rates, redirect: startRedirect(config, ask), certStore };
}

function dispatchDeps(
  d: NetworkDeps,
  resolveClientIp: ClientIpResolver,
  gate: DispatchDeps["controlGate"],
): DispatchDeps {
  const { ctx, http } = d;
  const { table } = ctx;
  return {
    baseDomain: d.baseDomain,
    previewDomains: () => ctx.domains?.wildcards() ?? [ctx.previewDomain()],
    table,
    limits: DEFAULT_LIMITS,
    surfaceEnabled: d.surfaceEnabled,
    controlGate: gate,
    visibilityGate: http.gate.handle,
    wake: waker(d),
    font: serveKitFont,
    site: siteFor(d),
    upstream: upstreamFor(d),
    handlers: {
      app: surfaceHandler(http.app, "app"),
      api: surfaceHandler(http.app, "api"),
      hooks: d.hooks.handler(),
      mcp: http.mcp.handler(),
    },
    logTailFor: (id) => ctx.logs.tail(id, 50),
    clientIpFor: clientIpFor(d, resolveClientIp),
    onProxied: (entry) => table.touch(entry.hostname, Date.now()),
    watermark: watermarkFor(d),
  };
}

// Visitors on a share link arrive through cloudflared on this machine, which is no trusted
// proxy; without its header they would all share one rate-limit and password-guess bucket.
function clientIpFor(
  { ctx, config }: NetworkDeps,
  resolveClientIp: ClientIpResolver,
): DispatchDeps["clientIpFor"] {
  const tunnelPeer = tunnelPeerFor(config.listenAddress);
  return (req) => {
    const peer = clientIpOf(req);
    const host = normalizeHost(req.headers.get("host"));
    if (host && ctx.shares?.isShareHost(host) && tunnelPeer(peer)) {
      return tunnelClientIp(req.headers) ?? peer;
    }
    return resolveClientIp(peer, req.headers.get("x-forwarded-for"));
  };
}

function watermarkFor({ ctx, settings }: NetworkDeps): NonNullable<DispatchDeps["watermark"]> {
  let cached: { link: string; script: string } | null = null;
  return {
    on: (entry) =>
      ctx.previews.watermarkOf(entry.previewId) ?? settings.get(SETTINGS.previewWatermark),
    script: () => {
      const link = settings.get(SETTINGS.previewWatermarkLink);
      if (cached?.link !== link) {
        cached = { link, script: markScript(link) };
      }
      return cached.script;
    },
  };
}

function waker({ ctx, config, logger }: NetworkDeps): NonNullable<DispatchDeps["wake"]> {
  const w = new Waker(ctx, logger.child({ mod: "wake" }));
  return async (entry) => {
    const woke = await Promise.race([
      w.wake(entry.previewId).then(
        () => true,
        () => false,
      ),
      sleep(config.wakeWaitMs).then(() => false),
    ]);
    return woke ? null : wakingPage(entry.hostname);
  };
}

function siteFor({ ctx }: NetworkDeps): NonNullable<DispatchDeps["site"]> {
  return async (req, entry) => {
    const site = await ctx.sites?.open(entry.previewId);
    if (!site) {
      return failedPage(entry.hostname, ["this preview's files are missing: redeploy it"]);
    }
    const lib = ctx.artifacts;
    return serveSite(req, site, {
      unlisted: entry.visibility === "unlisted",
      kitDir: renderDist(),
      ...(lib
        ? {
            themeCss: (id: string | null) => lib.themeCss(id, THEME_LOGO_PATH),
            themeLogo: (id: string | null) => lib.themeLogo(id),
          }
        : {}),
    });
  };
}

function upstreamFor({ ctx, config }: NetworkDeps): PerHostUpstream {
  return new PerHostUpstream((hostId) => {
    const host = ctx.hosts.get(hostId);
    return host
      ? new NodeHttpUpstream({
          dial: { dial: host.upstream.dial, proxy: host.upstream.proxy },
          limits: DEFAULT_LIMITS,
          timeoutMs: config.upstreamTimeoutMs,
          publicPort: config.publicPort,
        })
      : null;
  });
}

/** The names a proxy may get a certificate for: those gangway answers today. */
function answersFor(d: DispatchDeps): (host: string) => boolean {
  return (host) => {
    const kind = hostKind(host, d).kind;
    if (kind === "surface" || kind === "unknown") {
      return true;
    }
    return kind === "preview" && d.table.lookup(host) !== undefined;
  };
}

// Plain HTTP only redirects, except the ask a proxy in front makes before it gets a certificate.
function startRedirect(config: Config, ask: TlsAsk): ReturnType<typeof Bun.serve> | null {
  return config.listenHttpPort === null
    ? null
    : Bun.serve({
        hostname: config.listenAddress,
        port: config.listenHttpPort,
        fetch(req, server) {
          const answered = ask(req, server.requestIP(req)?.address ?? "");
          if (answered) {
            return answered;
          }
          const u = new URL(req.url);
          u.protocol = `${config.publicScheme}:`;
          u.port = String(config.publicPort);
          return Response.redirect(u.toString(), 308);
        },
      });
}
