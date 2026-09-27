import LOGO from "../../../web/public/logo.svg" with { type: "text" };
import LOGO_LIGHT from "../../../web/public/logo-light.svg" with { type: "text" };
import { isWebSocketUpgrade } from "./headers.ts";

// One script tag on every HTML page a preview answers; the script draws the mark (ADR-0032).

export const MARK_PATH = "/__gangway/mark.js";
const TAG = `<script src="${MARK_PATH}" async data-gangway-mark></script>`;
// A stamped page's validator is the upstream's plus this, so a revalidation still reaches it.
const SUFFIX = "-gwm";

/** A page load the mark could go on: a GET for a document, not an asset, a fetch or a socket. */
export function wantsMark(req: Request): boolean {
  if (req.method !== "GET" || isWebSocketUpgrade(req)) return false;
  const dest = req.headers.get("sec-fetch-dest");
  return dest === null || dest === "document";
}

/** Asks for the page uncompressed, as stamp() rewrites it, and drops a validator for the unmarked page. */
export function forMark(req: Request): Request {
  const headers = new Headers(req.headers);
  headers.set("accept-encoding", "identity");
  const tags = (headers.get("if-none-match") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.endsWith(`${SUFFIX}"`))
    .map((t) => `W/${t.replace(/^W\//, "").slice(0, -SUFFIX.length - 1)}"`);
  if (tags.length > 0) headers.set("if-none-match", tags.join(", "));
  else headers.delete("if-none-match");
  return new Request(req, { headers });
}

function markedTag(etag: string | null): string | null {
  if (!etag) return null;
  const inner = etag.replace(/^W\//, "");
  return inner.startsWith('"') && inner.endsWith('"') ? `W/${inner.slice(0, -1)}${SUFFIX}"` : null;
}

/** The page with the mark added before </body>, or at the end; anything else untouched. */
export function stamp(res: Response, req: Request): Response {
  if (res.status === 304) {
    const headers = new Headers(res.headers);
    const tag = markedTag(headers.get("etag"));
    if (tag) headers.set("etag", tag);
    return new Response(null, { status: 304, statusText: res.statusText, headers });
  }
  if (res.status !== 200 || !res.body) return res;
  const type = res.headers.get("content-type") ?? "";
  if (!/^text\/html\b/i.test(type)) return res;
  if (/\bno-transform\b/i.test(res.headers.get("cache-control") ?? "")) return res;
  const encoding = (res.headers.get("content-encoding") ?? "").trim().toLowerCase();
  let body: ReadableStream<Uint8Array> = res.body;
  if (encoding === "gzip" || encoding === "x-gzip")
    body = body.pipeThrough(
      new DecompressionStream("gzip") as ReadableWritablePair<Uint8Array, Uint8Array>,
    );
  else if (encoding !== "" && encoding !== "identity") return res;

  let added = false;
  const rewritten = new HTMLRewriter()
    .on("body", {
      element(e) {
        e.onEndTag((end) => {
          if (added) return;
          added = true;
          end.before(TAG, { html: true });
        });
      },
    })
    .onDocument({
      end(end) {
        if (!added) {
          added = true;
          end.append(TAG, { html: true });
        }
      },
    })
    .transform(new Response(body, { headers: { "content-type": type } }));

  const headers = new Headers(res.headers);
  for (const h of ["content-length", "content-encoding", "content-md5"]) headers.delete(h);
  const tag = markedTag(headers.get("etag"));
  if (tag) headers.set("etag", tag);
  else headers.delete("etag");
  headers.append("vary", "accept-encoding");
  let out = rewritten.body!;
  if (/\bgzip\b/i.test(req.headers.get("accept-encoding") ?? "")) {
    out = out.pipeThrough(new CompressionStream("gzip"));
    headers.set("content-encoding", "gzip");
  }
  return new Response(out, { status: 200, statusText: res.statusText, headers });
}

const svg = (s: string) => s.replace(/<title>.*?<\/title>/s, "").replace(/\s*\n\s*/g, "");

// Chart tokens; light or dark after the page's data-theme, the gw-theme cookie, or the OS.
const CSS = `
:host{all:initial;position:fixed;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));z-index:2147483000;
  --paper:oklch(0.97 0.012 85);--ink:oklch(0.27 0.06 255);--rule:oklch(0.84 0.025 240)}
a{display:flex;align-items:center;gap:10px;height:40px;padding:0 14px 0 11px;box-sizing:border-box;text-decoration:none;
  background:var(--paper);color:var(--ink);border-radius:2px;
  box-shadow:inset 0 0 0 1px var(--ink),inset 0 0 0 4px var(--paper),inset 0 0 0 5px var(--ink);
  font:600 15px/1 'gw-mark-mono','IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-.04em;
  -webkit-font-smoothing:antialiased;cursor:pointer}
a:hover .name{text-decoration:underline;text-underline-offset:2px}
a:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
svg{width:22px;height:22px;flex:none;display:block}
.dark{display:none}
.label{font:600 10px/1 'IBM Plex Sans Condensed','Arial Narrow',sans-serif;letter-spacing:.14em;text-transform:uppercase;
  padding-left:10px;border-left:1px solid var(--rule);opacity:.75}
@media (prefers-color-scheme:dark){
  :host(:not([data-theme=light])){--paper:oklch(0.2 0.035 255);--ink:oklch(0.94 0.015 85);--rule:oklch(0.36 0.04 250)}
  :host(:not([data-theme=light])) .light{display:none}:host(:not([data-theme=light])) .dark{display:block}
}
:host([data-theme=dark]){--paper:oklch(0.2 0.035 255);--ink:oklch(0.94 0.015 85);--rule:oklch(0.36 0.04 250)}
:host([data-theme=dark]) .light{display:none}:host([data-theme=dark]) .dark{display:block}
@media (max-width:520px){a{padding:0;width:40px;justify-content:center}.name,.label{display:none}}
@media print{:host{display:none}}
`;

/** The script behind MARK_PATH: the link goes to `link` (none when empty). */
export function markScript(link: string): string {
  const inner =
    `<span class="light">${svg(LOGO)}</span><span class="dark">${svg(LOGO_LIGHT)}</span>` +
    `<span class="name">gangway</span><span class="label">preview</span>`;
  const href = link ? ` href="${link.replace(/["<>&]/g, "")}" target="_blank" rel="noopener"` : "";
  const html = `<style>${CSS.replace(/\s*\n\s*/g, "")}</style><a${href} title="Made with gangway" aria-label="Made with gangway">${inner}</a>`;
  return `(()=>{if(window.top!==window.self||customElements.get("gangway-mark"))return;
try{var h=location.hostname.split(".").slice(1).join(".");if(h.indexOf(".")>0&&window.FontFace){var f=new FontFace("gw-mark-mono","url(//"+h+"/_gangway/fonts/mono-600.woff2)",{weight:"600"});f.load().then(function(x){document.fonts.add(x)},function(){})}}catch(e){}
customElements.define("gangway-mark",class extends HTMLElement{constructor(){super();this.attachShadow({mode:"closed"}).innerHTML=${JSON.stringify(html)}}
connectedCallback(){var m=this,d=document.documentElement,f=function(){var t=d.getAttribute("data-theme");if(t!=="light"&&t!=="dark")try{t=(/(?:^|;\\s*)gw-theme=(light|dark)(?:;|$)/.exec(document.cookie)||[])[1]}catch(e){}t?m.setAttribute("data-theme",t):m.removeAttribute("data-theme")};
f();new MutationObserver(f).observe(d,{attributes:true,attributeFilter:["data-theme"]});document.addEventListener("visibilitychange",f)}});
var put=function(){if(!document.querySelector("gangway-mark"))document.documentElement.appendChild(document.createElement("gangway-mark"))};
document.body?put():document.addEventListener("DOMContentLoaded",put);})();
`;
}

export function markResponse(req: Request, script: string): Response {
  const headers = {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "public, max-age=3600",
    "x-content-type-options": "nosniff",
  };
  return new Response(req.method === "HEAD" ? null : script, { headers });
}
