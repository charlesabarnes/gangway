import { stat } from "node:fs/promises";
import path from "node:path";
import { encodedFile, notModified, siblingSidecar } from "../net/encode.ts";
import { renderAssets, renderDist } from "../previews/artifact-render.ts";

// A sandboxed page the UI frames to draw the files it is sent, off the UI's origin.

export const FRAME_PATH = "/_gangway/frame.html";
const ASSET = /^\/_gangway\/(kit\.js|elk\.js|kit\.css|legacy\.css|theme\.css)$/;
const TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
};

const frame = (v: string) => `<!doctype html>
<html lang="en" data-pref="light"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/_gangway/kit.css?v=${v}"><style id="gw-theme"></style></head>
<body><script>
(function () {
  var files = {}, real = window.fetch.bind(window), started = false;
  window.fetch = function (u, o) {
    try {
      var p = new URL(typeof u === "string" ? u : u.url, location.href).pathname.replace(/^\\//, "");
      if (Object.prototype.hasOwnProperty.call(files, p)) return Promise.resolve(new Response(files[p]));
    } catch (e) {}
    return real(u, o);
  };
  addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.type !== "gw-render" || started) return;
    started = true;
    files = d.files || {};
    document.getElementById("gw-theme").textContent = (d.themeCss || "") + (d.chrome ? "" : ".gw-chrome{display:none!important}") + (d.still ? "html,body{overflow:hidden!important}" : "");
    document.documentElement.dataset.pref = d.mode || "light";
    if (d.hash) location.hash = d.hash;
    var told = false;
    function drawn() { if (!told) { told = true; parent.postMessage({ type: "gw-rendered" }, "*"); } }
    document.addEventListener("gw-drawn", drawn);
    import("/_gangway/kit.js?v=${v}").then(function () { setTimeout(drawn, 4000); }, drawn);
  });
  parent.postMessage({ type: "gw-frame-ready" }, "*");
})();
</script></body></html>
`;

const IMMUTABLE = "public, max-age=31536000, immutable";

/** The frame page and the kit it loads, for the UI; null for any other path. */
export async function serveKitFrame(req: Request, dist = renderDist()): Promise<Response | null> {
  const url = new URL(req.url);
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const version = renderAssets(dist).version;
  if (url.pathname === FRAME_PATH) {
    const headers = {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
      etag: `"${version}"`,
      "content-security-policy": "sandbox allow-scripts; frame-ancestors 'self'",
      "x-content-type-options": "nosniff",
    };
    if (notModified(req, headers.etag)) return new Response(null, { status: 304, headers });
    return new Response(req.method === "HEAD" ? null : frame(version), { headers });
  }
  const m = ASSET.exec(url.pathname);
  if (!m) return null;
  const abs = path.join(dist, m[1]!);
  const st = await stat(abs).catch(() => null);
  if (!st?.isFile()) return null;
  const headers: Record<string, string> = {
    "content-type": TYPES[m[1]!.split(".").pop()!]!,
    // A versioned URL names these exact bytes; any other is revalidated.
    "cache-control": url.searchParams.get("v") === version ? IMMUTABLE : "no-cache",
    etag: `"${version}-${m[1]!}"`,
    vary: "accept-encoding",
    // The sandboxed frame has no origin of its own, so the kit must be readable from anywhere.
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
  };
  if (notModified(req, headers["etag"]!)) return new Response(null, { status: 304, headers });
  const { body, encoding } = await encodedFile(
    req,
    abs,
    { size: st.size, mtime: st.mtimeMs, type: headers["content-type"]! },
    { sidecar: siblingSidecar },
  );
  if (encoding) headers["content-encoding"] = encoding;
  return new Response(req.method === "HEAD" ? null : body, { headers });
}
