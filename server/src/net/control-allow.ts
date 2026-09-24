import { isIP } from "node:net";
import { FONT_PATH } from "./page-chrome.ts";
import { parseTrustedProxies, unmap } from "./trusted-proxy.ts";

/** Whether this request may reach the UI and API. */
export type ControlGate = (req: Request, clientIp: string) => boolean;

// What strangers still need from the app host: preview pages, agents' OAuth servers and health checks.
const PUBLIC_PATHS = new Set([
  "/healthz",
  "/v1/auth/gate",
  "/v1/schema/gangway.yml",
  "/.well-known/oauth-authorization-server",
  "/oauth/token",
]);

export function isPublicControlPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname) || pathname.startsWith(FONT_PATH);
}

/**
 * Why this allow list may let the internet in anyway: behind a proxy, a client gangway cannot
 * see past looks like the proxy itself.
 */
export function controlAllowRisk(
  allow: readonly string[],
  trusted: readonly string[],
): string | null {
  if (allow.length === 0) return null;
  if (trusted.length === 0)
    return "GANGWAY_CONTROL_ALLOW is set but GANGWAY_TRUSTED_PROXIES is empty; behind a reverse proxy every client looks like the proxy, and the proxy's address decides for all of them";
  const list = parseTrustedProxies(allow, "control allow entry");
  const proxy = trusted.find((t) => {
    const ip = t.split("/")[0] ?? "";
    const family = isIP(ip);
    return family !== 0 && list.check(ip, family === 4 ? "ipv4" : "ipv6");
  });
  return proxy
    ? `GANGWAY_CONTROL_ALLOW includes the trusted proxy ${proxy}; a request the proxy does not forward a client address for is let in`
    : null;
}

export function controlGate(allow: readonly string[]): ControlGate | null {
  if (allow.length === 0) return null;
  const list = parseTrustedProxies(allow, "control allow entry");
  return (req, clientIp) => {
    if (isPublicControlPath(new URL(req.url).pathname)) return true;
    const ip = unmap(clientIp);
    const family = isIP(ip);
    return family !== 0 && list.check(ip, family === 4 ? "ipv4" : "ipv6");
  };
}
