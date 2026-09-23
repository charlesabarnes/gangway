/**
 * Client ID Metadata Documents (ADR-0020; the MCP authorization spec's preferred client
 * registration). A client's `client_id` IS an https URL; the document there names the
 * client and the redirect URIs it may use. claude.ai and Claude Code both register this way.
 *
 * Fetching a URL a stranger chose is server-side request forgery waiting to happen, so:
 *  - https on 443 only, no credentials in the URL, a path required (the spec's rules);
 *  - the address is checked AT CONNECT TIME by the socket's own `lookup`, so a DNS answer
 *    that changes between a check and the connect (rebinding) cannot reach the host's LAN,
 *    loopback, the docker bridge or a metadata service;
 *  - no redirects, 5 s, 64 KiB, JSON;
 *  - the document's `client_id` must equal the URL, byte for byte.
 * Cached per `Cache-Control`, clamped to 5 min .. 24 h; a failure is not cached.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { SingleFlight } from "../util/async.ts";

export type ClientMetadata = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
};

export class ClientMetadataError extends Error {}

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 5_000;
const MIN_TTL_MS = 5 * 60_000;
const MAX_TTL_MS = 24 * 3_600_000;
const MAX_CACHE = 500;

/** Everything a client-chosen URL must never reach. */
const PRIVATE = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  // Not ::ffff:0:0/96: BlockList matches EVERY IPv4 address against it. Mapped addresses
  // are unwrapped and judged as IPv4 below instead.
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  PRIVATE.addSubnet(net, bits, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  // An IPv4-mapped IPv6 address is judged as the IPv4 address it is.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return !PRIVATE.check(mapped[1]!, "ipv4");
  return !PRIVATE.check(address, family === 6 ? "ipv6" : "ipv4");
}

/** The spec's shape rules for a client_id URL, before any network. */
export function checkClientIdUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ClientMetadataError("client_id is not a URL");
  }
  if (u.protocol !== "https:") throw new ClientMetadataError("client_id must be an https URL");
  if (u.port !== "" && u.port !== "443")
    throw new ClientMetadataError("client_id must use the default https port");
  if (u.username || u.password)
    throw new ClientMetadataError("client_id must not carry credentials");
  if (u.hash) throw new ClientMetadataError("client_id must not have a fragment");
  if (u.pathname === "/" || u.pathname === "")
    throw new ClientMetadataError("client_id must have a path");
  if (u.href !== raw) throw new ClientMetadataError("client_id must be a normalized URL");
  if (isIP(u.hostname.replace(/^\[|\]$/g, "")) !== 0)
    throw new ClientMetadataError("client_id must name a host, not an address");
  return u;
}

/** The socket's own resolver: every address it would use must be public, or the connect fails. */
const safeLookup: typeof dnsLookup = ((
  hostname: string,
  options: unknown,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (list.length === 0 || bad) {
      return callback(
        Object.assign(
          new Error(
            `refusing to fetch client metadata from a non-public address (${bad?.address ?? "none"})`,
          ),
          { code: "EACCES" },
        ),
        "",
        0,
      );
    }
    const wantsAll =
      typeof options === "object" &&
      options !== null &&
      (options as { all?: boolean }).all === true;
    if (wantsAll) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}) as typeof dnsLookup;

export type Fetched = { status: number; contentType: string; cacheControl: string; body: string };
export type DocumentFetcher = (url: URL) => Promise<Fetched>;

/** The real fetch: node:https with the checked lookup, no redirects followed, capped. */
export const fetchDocument: DocumentFetcher = (url) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        lookup: safeLookup,
        timeout: TIMEOUT_MS,
        headers: { accept: "application/json", "user-agent": "gangway (OAuth client metadata)" },
      },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            req.destroy(new ClientMetadataError("client metadata document is larger than 64 KiB"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers["content-type"] ?? ""),
            cacheControl: String(res.headers["cache-control"] ?? ""),
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () =>
      req.destroy(new ClientMetadataError("client metadata document took longer than 5 s")),
    );
    req.on("error", reject);
    req.end();
  });

function ttlOf(cacheControl: string): number {
  const cc = cacheControl.toLowerCase();
  if (/\bno-store\b|\bno-cache\b/.test(cc)) return MIN_TTL_MS;
  const m = /\bmax-age=(\d+)/.exec(cc);
  const ms = m ? Number(m[1]) * 1000 : MIN_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, ms));
}

export function parseDocument(url: string, f: Fetched): ClientMetadata {
  if (f.status !== 200)
    throw new ClientMetadataError(`client metadata document answered ${f.status}`);
  if (!/^application\/(?:[\w.+-]*\+)?json\b/i.test(f.contentType))
    throw new ClientMetadataError("client metadata document is not JSON");
  let doc: unknown;
  try {
    doc = JSON.parse(f.body);
  } catch {
    throw new ClientMetadataError("client metadata document is not valid JSON");
  }
  if (!doc || typeof doc !== "object")
    throw new ClientMetadataError("client metadata document is not an object");
  const d = doc as Record<string, unknown>;
  if (d["client_id"] !== url)
    throw new ClientMetadataError("client metadata document's client_id does not match its URL");
  const uris = d["redirect_uris"];
  if (
    !Array.isArray(uris) ||
    uris.length === 0 ||
    uris.length > 20 ||
    !uris.every((u) => typeof u === "string" && u.length <= 2048)
  ) {
    throw new ClientMetadataError("client metadata document has no usable redirect_uris");
  }
  const method = d["token_endpoint_auth_method"];
  if (method !== undefined && method !== "none")
    throw new ClientMetadataError(
      `token_endpoint_auth_method ${JSON.stringify(method)} is not supported; gangway serves public clients only`,
    );
  const rawName = typeof d["client_name"] === "string" ? d["client_name"].trim() : "";
  // A name is shown to a person deciding whether to trust it: printable, short.
  const clientName =
    rawName
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
      .slice(0, 80) || new URL(url).hostname;
  return { clientId: url, clientName, redirectUris: uris as string[] };
}

export class ClientMetadataStore {
  readonly #fetch: DocumentFetcher;
  readonly #now: () => number;
  readonly #cache = new Map<string, { doc: ClientMetadata; until: number }>();
  readonly #flight = new SingleFlight<ClientMetadata>();

  constructor(o: { fetch?: DocumentFetcher; now?: () => number } = {}) {
    this.#fetch = o.fetch ?? fetchDocument;
    this.#now = o.now ?? Date.now;
  }

  async get(clientId: string): Promise<ClientMetadata> {
    const url = checkClientIdUrl(clientId);
    const hit = this.#cache.get(clientId);
    if (hit && hit.until > this.#now()) return hit.doc;
    return this.#flight.run(clientId, async () => {
      let fetched: Fetched;
      try {
        fetched = await this.#fetch(url);
      } catch (err) {
        throw err instanceof ClientMetadataError
          ? err
          : new ClientMetadataError(
              `could not fetch the client metadata document: ${(err as Error).message}`,
            );
      }
      const doc = parseDocument(clientId, fetched);
      if (this.#cache.size >= MAX_CACHE) this.#cache.delete(this.#cache.keys().next().value!);
      this.#cache.set(clientId, { doc, until: this.#now() + ttlOf(fetched.cacheControl) });
      return doc;
    });
  }
}

/**
 * Exact match, except a loopback redirect, which matches whatever port the client opened
 * this time (RFC 8252 §7.3): Claude Code listens on an ephemeral port.
 */
export function redirectAllowed(requested: string, registered: readonly string[]): boolean {
  if (registered.includes(requested)) return true;
  let r: URL;
  try {
    r = new URL(requested);
  } catch {
    return false;
  }
  const loopback = (u: URL) =>
    u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (!loopback(r)) return false;
  return registered.some((raw) => {
    try {
      const g = new URL(raw);
      return (
        loopback(g) &&
        g.hostname === r.hostname &&
        g.pathname === r.pathname &&
        g.search === r.search
      );
    } catch {
      return false;
    }
  });
}
