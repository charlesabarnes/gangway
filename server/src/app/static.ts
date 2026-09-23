import { join, normalize, sep } from "node:path";

const HASHED = /[.-][A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|png|svg|jpg|webp|ico|map)$/;

export type StaticOptions = { root: string; index?: string };

export async function serveStatic(req: Request, o: StaticOptions): Promise<Response | null> {
  if (req.method !== "GET" && req.method !== "HEAD") return null;

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url).pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;

  const root = normalize(o.root);
  const target = normalize(join(root, pathname));
  if (target !== root && !target.startsWith(root + sep)) return null;

  const index = join(root, o.index ?? "index.html");
  const hasExtension = /\.[A-Za-z0-9]+$/.test(pathname);

  const file = Bun.file(target);
  if (target !== root && hasExtension && (await file.exists())) {
    return respond(
      req,
      file,
      HASHED.test(pathname) ? "public, max-age=31536000, immutable" : "no-cache",
    );
  }
  if (hasExtension) return null;

  const shell = Bun.file(index);
  if (!(await shell.exists())) return null;
  return respond(req, shell, "no-cache");
}

function respond(req: Request, file: ReturnType<typeof Bun.file>, cacheControl: string): Response {
  const headers = {
    "content-type": file.type,
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
  };
  return new Response(req.method === "HEAD" ? null : file, { headers });
}
