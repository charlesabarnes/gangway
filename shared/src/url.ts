/**
 * The only place a public URL is constructed. Every externally-visible URL goes through
 * here: the sticky PR comment, the MCP deploy return value, the bootstrap admin link
 * printed to stdout, the public-URL env var injected into containers, and the `private`
 * login redirect.
 *
 * The public port is a separate input from the listen port: build from the listen port and
 * production emits `https://x.preview.example.com:443/`; hardcode 443 and every dev link
 * breaks. The default port for the scheme is elided.
 */
export type PublicOrigin = { scheme: "http" | "https"; port: number };

const DEFAULT_PORT: Record<PublicOrigin["scheme"], number> = { http: 80, https: 443 };

export function publicOriginFor(hostname: string, origin: PublicOrigin): string {
  const isDefault = origin.port === DEFAULT_PORT[origin.scheme];
  return `${origin.scheme}://${hostname}${isDefault ? "" : `:${origin.port}`}`;
}

export function publicUrlFor(hostname: string, origin: PublicOrigin, path = "/"): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${publicOriginFor(hostname, origin)}${p}`;
}
