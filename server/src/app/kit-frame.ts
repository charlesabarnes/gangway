import path from "node:path";
import { renderDist } from "../previews/artifact-render.ts";

// A sandboxed page the UI frames to draw the files it is sent, off the UI's origin.

export const FRAME_PATH = "/_gangway/frame.html";
const ASSET = /^\/_gangway\/(kit\.js|elk\.js|kit\.css|legacy\.css|theme\.css)$/;
const TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
};

const FRAME = `<!doctype html>
<html lang="en" data-pref="light"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/_gangway/kit.css"><style id="gw-theme"></style></head>
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
    import("/_gangway/kit.js").then(function () {
      setTimeout(function () { parent.postMessage({ type: "gw-rendered" }, "*"); }, 60);
    });
  });
  parent.postMessage({ type: "gw-frame-ready" }, "*");
})();
</script></body></html>
`;

/** The frame page and the kit it loads, for the UI; null for any other path. */
export async function serveKitFrame(req: Request, dist = renderDist()): Promise<Response | null> {
  const { pathname } = new URL(req.url);
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  if (pathname === FRAME_PATH)
    return new Response(req.method === "HEAD" ? null : FRAME, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        "content-security-policy": "sandbox allow-scripts; frame-ancestors 'self'",
        "x-content-type-options": "nosniff",
      },
    });
  const m = ASSET.exec(pathname);
  if (!m) return null;
  const file = Bun.file(path.join(dist, m[1]!));
  if (!(await file.exists())) return null;
  return new Response(req.method === "HEAD" ? null : file, {
    headers: {
      "content-type": TYPES[m[1]!.split(".").pop()!]!,
      "cache-control": "no-cache",
      // The sandboxed frame has no origin of its own, so the kit must be readable from anywhere.
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    },
  });
}
