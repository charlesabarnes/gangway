import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

/** A preview's files on disk, as gangway serves them in place of a container. */
export type ServedSite = {
  root: string;
  /** Holds root/ and gangway's own files for the site (kit-config.json). */
  dir: string;
  fallback: "spa" | "404";
  kit: boolean;
};

export type SiteServeOptions = {
  unlisted: boolean;
  /** The built kit (render/dist), served at /_gangway/ to a site that uses it. */
  kitDir: string;
};

const KIT_PREFIX = "/_gangway/";
const COMPRESSIBLE =
  /^(text\/|application\/(javascript|json|xml|manifest\+json|wasm)|image\/svg\+xml)/;
const GZIP_MIN = 1024;
const GZIP_MAX = 8 * 1024 * 1024;
const KIT_GZIP = new Map<string, { mtime: number; body: Uint8Array }>();

type Found = { abs: string; size: number; mtime: number };

function segmentsOf(pathname: string): string[] | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const parts = decoded.split("/").filter((s) => s !== "" && s !== ".");
  return parts.some((s) => s === "..") ? null : parts;
}

// lstat, so a symlink is never followed out of the site.
async function stat(
  abs: string,
): Promise<{ file: boolean; dir: boolean; size: number; mtime: number } | null> {
  const st = await lstat(abs).catch(() => null);
  if (!st) return null;
  return { file: st.isFile(), dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
}

async function fileAt(base: string, parts: readonly string[]): Promise<Found | null> {
  const abs = path.join(base, ...parts);
  const st = await stat(abs);
  return st?.file ? { abs, size: st.size, mtime: st.mtime } : null;
}

const plain = (status: number, text: string, extra: Record<string, string> = {}) =>
  new Response(`${text}\n`, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });

async function bodyFor(
  req: Request,
  f: Found,
  type: string,
  cacheKit: boolean,
): Promise<{ body: Uint8Array | Blob; gzip: boolean }> {
  const wantsGzip = /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "");
  if (!wantsGzip || !COMPRESSIBLE.test(type) || f.size < GZIP_MIN || f.size > GZIP_MAX)
    return { body: Bun.file(f.abs), gzip: false };
  const hit = cacheKit ? KIT_GZIP.get(f.abs) : undefined;
  if (hit && hit.mtime === f.mtime) return { body: hit.body, gzip: true };
  const body = gzipSync(await readFile(f.abs));
  if (cacheKit) KIT_GZIP.set(f.abs, { mtime: f.mtime, body });
  return { body, gzip: true };
}

async function send(
  req: Request,
  f: Found,
  o: SiteServeOptions,
  r: { status?: number; kit?: boolean } = {},
): Promise<Response> {
  const type = Bun.file(f.abs).type || "application/octet-stream";
  const etag = `W/"${f.size.toString(16)}-${Math.floor(f.mtime).toString(16)}"`;
  const headers: Record<string, string> = {
    "content-type": type,
    "x-content-type-options": "nosniff",
    "cache-control": r.kit ? "public, max-age=86400" : "no-cache",
    etag,
    "last-modified": new Date(f.mtime).toUTCString(),
    vary: "accept-encoding",
  };
  if (o.unlisted) headers["x-robots-tag"] = "noindex, nofollow";
  const status = r.status ?? 200;
  if (status === 200 && req.headers.get("if-none-match") === etag)
    return new Response(null, { status: 304, headers });
  const { body, gzip } = await bodyFor(req, f, type, r.kit === true);
  if (gzip) headers["content-encoding"] = "gzip";
  return new Response(req.method === "HEAD" ? null : body, { status, headers });
}

async function serveKit(
  req: Request,
  site: ServedSite,
  rest: string[],
  o: SiteServeOptions,
): Promise<Response> {
  if (rest.length === 1 && rest[0] === "config.json") {
    const f = await fileAt(site.dir, ["kit-config.json"]);
    if (f) return send(req, f, o);
  }
  const f = await fileAt(o.kitDir, rest);
  return f ? send(req, f, o, { kit: true }) : plain(404, "not found");
}

type Lookup = { found: Found } | { redirect: string } | null;

// nginx's try_files $uri $uri/ $uri.html, with index.html and index.htm as the index.
async function lookup(root: string, url: URL, parts: string[]): Promise<Lookup> {
  const slash = url.pathname.endsWith("/");
  const st = parts.length === 0 ? null : await stat(path.join(root, ...parts));
  if (st?.file) return { found: { abs: path.join(root, ...parts), ...st } };
  if (st?.dir && !slash) return { redirect: `${url.pathname}/${url.search}` };
  if (parts.length === 0 || st?.dir) {
    for (const index of ["index.html", "index.htm"]) {
      const f = await fileAt(root, [...parts, index]);
      if (f) return { found: f };
    }
  }
  if (parts.length === 0 || slash) return null;
  const f = await fileAt(root, [...parts.slice(0, -1), `${parts[parts.length - 1]!}.html`]);
  return f ? { found: f } : null;
}

async function fallback(req: Request, site: ServedSite, o: SiteServeOptions): Promise<Response> {
  const spa = site.fallback === "spa";
  const f = await fileAt(site.root, [spa ? "index.html" : "404.html"]);
  if (!f) return plain(404, "not found");
  return spa ? send(req, f, o) : send(req, f, o, { status: 404 });
}

/** Answers from a site's files the way the static runtime's nginx did. */
export async function serveSite(
  req: Request,
  site: ServedSite,
  o: SiteServeOptions,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD")
    return plain(405, "method not allowed", { allow: "GET, HEAD" });
  const url = new URL(req.url);
  const parts = segmentsOf(url.pathname);
  if (parts === null) return plain(400, "bad request");
  if (site.kit && url.pathname.startsWith(KIT_PREFIX))
    return serveKit(req, site, parts.slice(1), o);

  const hit = await lookup(site.root, url, parts);
  if (hit && "redirect" in hit)
    return new Response(null, { status: 301, headers: { location: hit.redirect } });
  return hit ? send(req, hit.found, o) : fallback(req, site, o);
}
