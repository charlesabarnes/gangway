import { stat } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { encodedFile, HASHED, notModified, siblingSidecar } from "../net/encode.ts";

export type StaticOptions = { root: string; index?: string };

export async function serveStatic(req: Request, o: StaticOptions): Promise<Response | null> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return null;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url).pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) {
    return null;
  }

  const root = normalize(o.root);
  const target = normalize(join(root, pathname));
  if (target !== root && !target.startsWith(root + sep)) {
    return null;
  }

  const hasExtension = /\.[A-Za-z0-9]+$/.test(pathname);
  if (target !== root && hasExtension) {
    const st = await stat(target).catch(() => null);
    if (!st?.isFile()) {
      return null;
    }
    return respond(
      req,
      target,
      st,
      HASHED.test(pathname) ? "public, max-age=31536000, immutable" : "no-cache",
    );
  }
  if (hasExtension) {
    return null;
  }

  const index = join(root, o.index ?? "index.html");
  const st = await stat(index).catch(() => null);
  if (!st?.isFile()) {
    return null;
  }
  return respond(req, index, st, "no-cache");
}

async function respond(
  req: Request,
  abs: string,
  st: { size: number; mtimeMs: number },
  cacheControl: string,
): Promise<Response> {
  const type = Bun.file(abs).type;
  const headers: Record<string, string> = {
    "content-type": type,
    "cache-control": cacheControl,
    etag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
    "last-modified": new Date(st.mtimeMs).toUTCString(),
    vary: "accept-encoding",
    "x-content-type-options": "nosniff",
  };
  if (notModified(req, headers["etag"]!, st.mtimeMs)) {
    return new Response(null, { status: 304, headers });
  }
  const { body, encoding } = await encodedFile(
    req,
    abs,
    { size: st.size, mtime: st.mtimeMs, type },
    { sidecar: siblingSidecar },
  );
  if (encoding) {
    headers["content-encoding"] = encoding;
  }
  return new Response(req.method === "HEAD" ? null : body, { headers });
}
