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
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#171717;--muted:#737373;--card:#fff;--line:#e5e5e5;--err:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--fg:#f5f5f5;--muted:#a3a3a3;--card:#171717;--line:#262626;--err:#f87171}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:16px}
form{width:100%;max-width:360px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:17px;margin:0 0 4px}p{margin:0 0 16px;color:var(--muted);font-size:13px;overflow-wrap:anywhere}
input[type=password]{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
button{margin-top:12px;width:100%;padding:9px;border:0;border-radius:8px;background:var(--fg);color:var(--bg);font:inherit;font-weight:600;cursor:pointer}
.err{color:var(--err);margin:10px 0 0;font-size:13px}
</style></head><body>
<form method="post" action="${PASSWORD_PATH}">
<h1>This preview is password-protected</h1>
<p>${escapeHtml(host)}</p>
<input type="hidden" name="to" value="${escapeHtml(to)}">
<input type="password" name="password" autocomplete="current-password" aria-label="Password" placeholder="Password" required autofocus>
<button type="submit">Open preview</button>
${error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : ""}
</form></body></html>
`;
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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
