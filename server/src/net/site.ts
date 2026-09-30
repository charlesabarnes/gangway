import { lstat } from "node:fs/promises";
import path from "node:path";
import { renderAssets } from "../previews/artifact-render.ts";
import {
  compress,
  compressible,
  encodedFile,
  HASHED,
  negotiate,
  notModified,
  siblingSidecar,
  singleRange,
  type Encoding,
} from "./encode.ts";

/** A preview's files on disk, as gangway serves them in place of a container. */
export type ServedSite = {
  root: string;
  /** Holds root/ and gangway's own files for the site (kit-config.json). */
  dir: string;
  fallback: "spa" | "404";
  kit: boolean;
  theme?: string | null | undefined;
};

export type SiteServeOptions = {
  unlisted: boolean;
  /** The built kit (render/dist), served at /_gangway/ to a site that uses it. */
  kitDir: string;
  /** A theme's CSS and logo by id (null: the server's default); null keeps the kit's own. */
  themeCss?: ((id: string | null) => string | null) | undefined;
  themeLogo?: ((id: string | null) => string | null) | undefined;
};

export const THEME_LOGO_PATH = "/_gangway/theme-logo.svg";

const KIT_PREFIX = "/_gangway/";
/** Where publish puts a site's precompressed copies: beside root/, never served as files. */
export const ENCODED_DIR = "enc";

type Found = { abs: string; size: number; mtime: number };

function segmentsOf(pathname: string): string[] | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    return null;
  }
  const parts = decoded.split("/").filter((s) => s !== "" && s !== ".");
  return parts.includes("..") ? null : parts;
}

// lstat, so a symlink is never followed out of the site.
async function stat(
  abs: string,
): Promise<{ file: boolean; dir: boolean; size: number; mtime: number } | null> {
  const st = await lstat(abs).catch(() => null);
  if (!st) {
    return null;
  }
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

function kitVersion(dir: string): string | null {
  try {
    return renderAssets(dir).version;
  } catch {
    return null;
  }
}

/** The precompressed copy of a file under root/, in the site's enc/ tree. */
export function siteSidecar(site: Pick<ServedSite, "root" | "dir">) {
  return (abs: string, enc: Encoding) =>
    path.join(
      site.dir,
      ENCODED_DIR,
      `${path.relative(site.root, abs)}.${enc === "br" ? "br" : "gz"}`,
    );
}

const KIT_LINK = /(\/_gangway\/kit\.(?:css|js))\?v=[\w-]+/g;
const MAX_PAGES = 500;
type Page = { key: string; html: Uint8Array; gzip: Uint8Array | null };
const pages = new Map<string, Page>();

// A kit site's page links the kit by the version it was rendered with, and a matching version is
// cached for good, so a page from before an upgrade would keep its visitors on the old kit.
async function kitPage(f: Found, version: string): Promise<Page | null> {
  const key = `${f.size}:${f.mtime}:${version}`;
  const hit = pages.get(f.abs);
  if (hit?.key === key) {
    return hit;
  }
  const text = await Bun.file(f.abs).text();
  let stale = 0;
  const out = text.replace(KIT_LINK, (m, link: string) => {
    const now = `${link}?v=${version}`;
    if (now !== m) {
      stale++;
    }
    return now;
  });
  if (stale === 0) {
    return null;
  }
  const html = new TextEncoder().encode(out);
  const page = {
    key,
    html,
    gzip: compressible("text/html", html.byteLength) ? await compress(html, "gzip", true) : null,
  };
  const oldest = pages.keys().next();
  if (pages.size >= MAX_PAGES && !oldest.done) {
    pages.delete(oldest.value);
  }
  pages.set(f.abs, page);
  return page;
}

type KitPageServe = { page: Page; f: Found; version: string; status: number };

function sendKitPage(
  req: Request,
  { page, f, version, status }: KitPageServe,
  o: SiteServeOptions,
): Response {
  // The version is in the validator, and If-Modified-Since is not consulted, so an upgrade is never a 304.
  const etag = `W/"${f.size.toString(16)}-${Math.floor(f.mtime).toString(16)}-${version}"`;
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff",
    "cache-control": "no-cache",
    etag,
    vary: "accept-encoding",
  };
  if (o.unlisted) {
    headers["x-robots-tag"] = "noindex, nofollow";
  }
  if (status === 200 && notModified(req, etag)) {
    return new Response(null, { status: 304, headers });
  }
  if (req.method === "HEAD") {
    return new Response(null, { status, headers });
  }
  const gzip = page.gzip && negotiate(req.headers.get("accept-encoding")) !== null;
  if (gzip) {
    headers["content-encoding"] = "gzip";
  }
  return new Response(gzip ? page.gzip : page.html, { status, headers });
}

/** A file from a site's root: a kit page whose kit links are stale gets them rewritten first. */
async function sendSiteFile(
  req: Request,
  f: Found,
  { o, site }: { o: SiteServeOptions; site: ServedSite },
  status = 200,
): Promise<Response> {
  const version = site.kit && /\.html?$/i.test(f.abs) ? kitVersion(o.kitDir) : null;
  const page = version ? await kitPage(f, version) : null;
  if (page && version) {
    return sendKitPage(req, { page, f, version, status }, o);
  }
  return send(req, f, o, { status, site });
}

function cacheControl(immutable: boolean, kit: boolean): string {
  if (immutable) {
    return "public, max-age=31536000, immutable";
  }
  return kit ? "public, max-age=86400" : "no-cache";
}

async function send(
  req: Request,
  f: Found,
  o: SiteServeOptions,
  r: { status?: number; kit?: boolean; site?: ServedSite; versioned?: boolean } = {},
): Promise<Response> {
  const type = Bun.file(f.abs).type || "application/octet-stream";
  const etag = `W/"${f.size.toString(16)}-${Math.floor(f.mtime).toString(16)}"`;
  const immutable = r.versioned === true || (!r.kit && HASHED.test(f.abs));
  const headers: Record<string, string> = {
    "content-type": type,
    "x-content-type-options": "nosniff",
    "cache-control": cacheControl(immutable, r.kit === true),
    etag,
    "last-modified": new Date(f.mtime).toUTCString(),
    vary: "accept-encoding",
    "accept-ranges": "bytes",
  };
  if (o.unlisted) {
    headers["x-robots-tag"] = "noindex, nofollow";
  }
  const status = r.status ?? 200;
  if (status === 200 && notModified(req, etag, f.mtime)) {
    return new Response(null, { status: 304, headers });
  }
  if (req.method === "HEAD") {
    return new Response(null, { status, headers });
  }

  const range = status === 200 ? singleRange(req.headers.get("range"), f.size) : null;
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "content-range": `bytes */${f.size}` },
    });
  }
  if (range) {
    headers["content-range"] = `bytes ${range.start}-${range.end}/${f.size}`;
    return new Response(Bun.file(f.abs).slice(range.start, range.end + 1), {
      status: 206,
      headers,
    });
  }
  let sidecar;
  if (r.kit) {
    sidecar = siblingSidecar;
  } else if (r.site) {
    sidecar = siteSidecar(r.site);
  }
  const { body, encoding } = await encodedFile(
    req,
    f.abs,
    { size: f.size, mtime: f.mtime, type },
    { sidecar },
  );
  if (encoding) {
    headers["content-encoding"] = encoding;
  }
  return new Response(body, { status, headers });
}

async function serveKit(
  req: Request,
  site: ServedSite,
  rest: string[],
  o: SiteServeOptions,
): Promise<Response> {
  if (rest.length === 1 && rest[0] === "config.json") {
    const f = await fileAt(site.dir, ["kit-config.json"]);
    if (f) {
      return send(req, f, o);
    }
  }
  if (rest.length === 1 && rest[0] === "theme.css") {
    const css = o.themeCss?.(site.theme ?? null);
    if (css !== null && css !== undefined) {
      return themeResponse(req, css, "text/css");
    }
  }
  if (rest.length === 1 && rest[0] === "theme-logo.svg") {
    const svg = o.themeLogo?.(site.theme ?? null);
    return svg ? themeResponse(req, svg, "image/svg+xml") : plain(404, "not found");
  }
  const f = await fileAt(o.kitDir, rest);
  const v = new URL(req.url).searchParams.get("v");
  const versioned = v !== null && v === kitVersion(o.kitDir);
  return f ? send(req, f, o, { kit: true, versioned }) : plain(404, "not found");
}

// Short-lived: a theme edited in the UI restyles every artifact that uses it on the next load.
function themeResponse(req: Request, body: string, type: string): Response {
  const etag = `W/"${Bun.hash(body).toString(36)}"`;
  const headers = {
    "content-type": `${type}; charset=utf-8`,
    "cache-control": "no-cache",
    etag,
    "x-content-type-options": "nosniff",
    // A logo is only ever an image; nothing in it may run.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  };
  if (notModified(req, etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(req.method === "HEAD" ? null : body, { headers });
}

type Lookup = { found: Found } | { redirect: string } | null;

// nginx's try_files $uri $uri/ $uri.html, with index.html and index.htm as the index.
async function lookup(root: string, url: URL, parts: string[]): Promise<Lookup> {
  const slash = url.pathname.endsWith("/");
  const st = parts.length === 0 ? null : await stat(path.join(root, ...parts));
  if (st?.file) {
    return { found: { abs: path.join(root, ...parts), ...st } };
  }
  if (st?.dir && !slash) {
    return { redirect: `${url.pathname}/${url.search}` };
  }
  if (parts.length === 0 || st?.dir) {
    for (const index of ["index.html", "index.htm"]) {
      const f = await fileAt(root, [...parts, index]);
      if (f) {
        return { found: f };
      }
    }
  }
  const last = parts.at(-1);
  if (last === undefined || slash) {
    return null;
  }
  const f = await fileAt(root, [...parts.slice(0, -1), `${last}.html`]);
  return f ? { found: f } : null;
}

async function fallback(req: Request, site: ServedSite, o: SiteServeOptions): Promise<Response> {
  const spa = site.fallback === "spa";
  const f = await fileAt(site.root, [spa ? "index.html" : "404.html"]);
  if (!f) {
    return plain(404, "not found");
  }
  return spa ? sendSiteFile(req, f, { o, site }) : sendSiteFile(req, f, { o, site }, 404);
}

/** Answers from a site's files the way the static runtime's nginx did. */
export async function serveSite(
  req: Request,
  site: ServedSite,
  o: SiteServeOptions,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return plain(405, "method not allowed", { allow: "GET, HEAD" });
  }
  const url = new URL(req.url);
  const parts = segmentsOf(url.pathname);
  if (parts === null) {
    return plain(400, "bad request");
  }
  if (site.kit && url.pathname.startsWith(KIT_PREFIX)) {
    return serveKit(req, site, parts.slice(1), o);
  }

  const hit = await lookup(site.root, url, parts);
  if (hit && "redirect" in hit) {
    return new Response(null, { status: 301, headers: { location: hit.redirect } });
  }
  return hit ? sendSiteFile(req, hit.found, { o, site }) : fallback(req, site, o);
}
