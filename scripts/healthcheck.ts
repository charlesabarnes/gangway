const port = process.env["GANGWAY_LISTEN_PORT"] ?? "8443";
const base = process.env["GANGWAY_BASE_DOMAIN"] ?? "preview.localhost";
// A wildcard bind answers on loopback; a specific one only on itself.
const listen = process.env["GANGWAY_LISTEN_ADDRESS"] ?? "::";
const addr =
  listen === "::" || listen === "0.0.0.0" || listen === ""
    ? "127.0.0.1"
    : listen.includes(":")
      ? `[${listen}]`
      : listen;
try {
  const res = await fetch(`https://${addr}:${port}/healthz`, {
    headers: { host: `api.${base}` },
    signal: AbortSignal.timeout(4_000),
    // This checks that gangway serves, not that the chain is valid (it may be the dev CA).
    tls: { rejectUnauthorized: false },
  } as RequestInit);
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
