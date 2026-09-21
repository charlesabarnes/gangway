/**
 * The container HEALTHCHECK. Asks the real listener -- TLS, Host dispatch and all -- for
 * /healthz on the `api` surface. Certificate verification is off on purpose: this checks
 * that gangway is serving, not that the certificate chains (it may be the dev CA).
 * Exit 0 healthy, 1 not. A draining server answers 503, which is "not healthy": correct.
 */
const port = process.env["GANGWAY_LISTEN_PORT"] ?? "8443";
const base = process.env["GANGWAY_BASE_DOMAIN"] ?? "preview.localhost";
// A wildcard bind answers on loopback; a specific one (docker0, behind a proxy) only on itself.
const listen = process.env["GANGWAY_LISTEN_ADDRESS"] ?? "::";
const addr = listen === "::" || listen === "0.0.0.0" || listen === "" ? "127.0.0.1" : listen.includes(":") ? `[${listen}]` : listen;
try {
  const res = await fetch(`https://${addr}:${port}/healthz`, {
    headers: { host: `api.${base}` }, signal: AbortSignal.timeout(4_000), tls: { rejectUnauthorized: false },
  } as RequestInit);
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
