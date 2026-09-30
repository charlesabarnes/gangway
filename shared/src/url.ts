export type PublicOrigin = { scheme: "http" | "https"; port: number };

const DEFAULT_PORT: Record<PublicOrigin["scheme"], number> = { http: 80, https: 443 };

export function publicOriginFor(hostname: string, origin: PublicOrigin): string {
  const isDefault = origin.port === DEFAULT_PORT[origin.scheme];
  const port = isDefault ? "" : `:${origin.port}`;
  return `${origin.scheme}://${hostname}${port}`;
}

export function publicUrlFor(hostname: string, origin: PublicOrigin, path = "/"): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${publicOriginFor(hostname, origin)}${p}`;
}
