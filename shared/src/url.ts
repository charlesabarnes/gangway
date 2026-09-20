/**
 * The ONLY place a public URL is constructed (spec §13: ports are configuration).
 *
 * Every externally-visible URL goes through here: the sticky PR comment, the MCP deploy
 * return value, the bootstrap admin link printed to stdout, the public-URL env var
 * injected into containers (§6.4), and the `private` login redirect.
 *
 * Build one from the LISTEN port and production emits `https://x.preview.example.com:443/`.
 * Hardcode 443 and every dev link breaks. Hence publicPort is a separate input from
 * listen.port, and the default port for the scheme is elided.
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
