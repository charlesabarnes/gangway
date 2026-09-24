import LOGO from "../../../web/public/logo.svg" with { type: "text" };
import LOGO_LIGHT from "../../../web/public/logo-light.svg" with { type: "text" };
import { FAVICON_LINK, fontFaces, fontSrc } from "./page-chrome.ts";

export const PASSWORD_PATH = "/__gangway/password";
const MAX_FORM_BYTES = 8 * 1024;

export function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

export async function readForm(req: Request): Promise<URLSearchParams | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_FORM_BYTES) return null;
  if (!req.body) return new URLSearchParams();
  const reader = (req.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FORM_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

// The "Chart" look of the web UI's login card. The CSP allows no images, so the mark is inlined from
// the same files the UI serves; Plex comes from the app host.
const PAGE_CSS = `
:root{color-scheme:light dark;--paper:oklch(0.97 0.012 85);--ink:oklch(0.27 0.06 255);--muted:oklch(0.48 0.04 255);--rule:oklch(0.84 0.025 240);--primary:oklch(0.33 0.09 255);--primary-fg:oklch(0.97 0.012 85);--flag:oklch(0.84 0.15 88);--danger:oklch(0.55 0.19 28)}
@media (prefers-color-scheme:dark){:root{--paper:oklch(0.2 0.035 255);--ink:oklch(0.94 0.015 85);--muted:oklch(0.72 0.03 250);--rule:oklch(0.36 0.04 250);--primary:oklch(0.84 0.15 88);--primary-fg:oklch(0.22 0.05 255);--danger:oklch(0.62 0.18 28)}.on-light{display:none!important}}
@media not (prefers-color-scheme:dark){.on-dark{display:none!important}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;color:var(--ink);background-color:var(--paper);background-image:linear-gradient(var(--rule) 1px,transparent 1px),linear-gradient(90deg,var(--rule) 1px,transparent 1px);background-size:80px 80px;background-position:-1px -1px;font:15px/1.4 'IBM Plex Sans Condensed','Roboto Condensed','Arial Narrow',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
form{width:100%;max-width:380px;display:flex;flex-direction:column;gap:22px;padding:40px;background:var(--paper);box-shadow:inset 0 0 0 1px var(--ink),inset 0 0 0 4px var(--paper),inset 0 0 0 5px var(--ink)}
.brand{display:flex;align-items:center;gap:10px;font:600 20px 'IBM Plex Mono',ui-monospace,Menlo,monospace;letter-spacing:-.04em}
.mark{display:flex}.mark svg{width:31px;height:31px}
h1{margin:0;font:italic 400 30px/1.1 'IBM Plex Serif',Georgia,serif}
.host{margin:6px 0 0;color:var(--muted);font:13px 'IBM Plex Mono',ui-monospace,Menlo,monospace;overflow-wrap:anywhere}
label{margin-bottom:-18px;color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase}
input[type=password]{width:100%;padding:8px 0;border:0;border-bottom:1px solid var(--ink);border-radius:0;background:transparent;color:inherit;font:16px 'IBM Plex Mono',ui-monospace,Menlo,monospace;outline:none}
input[type=password]:focus-visible{box-shadow:0 2px 0 var(--flag)}
button{padding:13px;border:0;border-radius:2px;background:var(--primary);color:var(--primary-fg);font:inherit;font-size:14px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;cursor:pointer}
button:focus-visible{outline:2px solid var(--flag);outline-offset:2px}
.err{margin:-8px 0 0;color:var(--danger);font-size:13px}
`;

const escapeHtml = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function passwordPage(
  host: string,
  to: string,
  error: string | null,
  status: number,
  retryAfterSec?: number,
): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Password required</title>
${FAVICON_LINK}
<style>${fontFaces(host)}${PAGE_CSS}</style></head><body>
<form method="post" action="${PASSWORD_PATH}">
<div class="brand"><span class="mark on-light" aria-hidden="true">${LOGO}</span><span class="mark on-dark" aria-hidden="true">${LOGO_LIGHT}</span>gangway</div>
<div><h1>This preview is password-protected</h1>
<p class="host">${escapeHtml(host)}</p></div>
<input type="hidden" name="to" value="${escapeHtml(to)}">
<label for="pw">Password</label>
<input id="pw" type="password" name="password" autocomplete="current-password" required autofocus>
<button type="submit">Open preview</button>
${error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : ""}
</form></body></html>
`;
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; img-src data:; ${fontSrc(host)} form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  };
  if (retryAfterSec !== undefined) headers["retry-after"] = String(retryAfterSec);
  return new Response(html, { status, headers });
}

export function plain(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
