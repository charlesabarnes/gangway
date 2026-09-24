import { surfaceHandler } from "../app/app.ts";
import type { Config } from "../config.ts";
import type { Hooks } from "../forge/hooks.ts";
import type { Logger } from "../logger.ts";
import type { DispatchDeps, Surface } from "../net/dispatch.ts";
import { failedPage, wakingPage } from "../net/error-pages.ts";
import { DEFAULT_LIMITS } from "../net/limits.ts";
import { controlAllowRisk, controlGate } from "../net/control-allow.ts";
import { clientIpOf, startListener, type RunningListener } from "../net/listener.ts";
import { clientIpResolver, type ClientIpResolver } from "../net/trusted-proxy.ts";
import { serveSite } from "../net/site.ts";
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
};

export type Network = {
  listener: RunningListener;
  redirect: ReturnType<typeof Bun.serve> | null;
  certStore: CertStore;
};

export function surfaceEnabledBy(settings: Settings): (s: Surface) => boolean {
  return (s) => {
    if (s === "app") return settings.get(SETTINGS.surfacesUi);
    if (s === "mcp") return settings.get(SETTINGS.surfacesMcp);
    return true;
  };
}

export function startNetwork(d: NetworkDeps): Network {
  const { config, logger } = d;
  // Throws at boot so a typo can't silently mean trust nobody.
  const resolveClientIp = clientIpResolver(config.trustedProxies);
  if (config.trustedProxies.length > 0)
    logger.info("trusting X-Forwarded-For from reverse proxies", {
      trustedProxies: config.trustedProxies,
    });

  const gate = controlGate(config.controlAllow);
  if (gate)
    logger.info("the UI and API answer only these networks", {
      controlAllow: config.controlAllow,
    });
  const risk = controlAllowRisk(config.controlAllow, config.trustedProxies);
  if (risk) logger.warn(risk);

  const certStore = new CertStore(d.bundle);
  const listener = startListener({
    hostname: config.listenAddress,
    port: config.listenPort,
    maxRequestBodySize: config.maxBodyBytes,
    idleTimeout: 120,
    certStore,
    deps: dispatchDeps(d, resolveClientIp, gate ?? undefined),
    onError: (e) => logger.error("listener error", { err: e }),
  });
  return { listener, redirect: startRedirect(config), certStore };
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
    previewDomain: ctx.previewDomain,
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
    clientIpFor: (req) => resolveClientIp(clientIpOf(req), req.headers.get("x-forwarded-for")),
    onProxied: (entry) => table.touch(entry.hostname, Date.now()),
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
    if (!site) return failedPage(entry.hostname, ["this preview's files are missing: redeploy it"]);
    return serveSite(req, site, {
      unlisted: entry.visibility === "unlisted",
      kitDir: renderDist(),
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

function startRedirect(config: Config): ReturnType<typeof Bun.serve> | null {
  return config.listenHttpPort === null
    ? null
    : Bun.serve({
        hostname: config.listenAddress,
        port: config.listenHttpPort,
        fetch(req) {
          const u = new URL(req.url);
          u.protocol = `${config.publicScheme}:`;
          u.port = String(config.publicPort);
          return Response.redirect(u.toString(), 308);
        },
      });
}
