/**
 * State-aware pages. A preview visitor is untrusted, so these never leak a
 * stack trace -- and "building" must say so with a link to its logs, because a bare 502
 * during a two-minute build is the single most confusing thing this system can do.
 */
import { escapeHtml } from "../util/html.ts";

type PageOpts = {
  title: string;
  heading: string;
  body: string;
  refreshSeconds?: number;
  status: number;
};

function page(o: PageOpts): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(o.title)}</title>
${o.refreshSeconds ? `<meta http-equiv="refresh" content="${o.refreshSeconds}">` : ""}
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;
  font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  background:#fafafa;color:#18181b}
@media(prefers-color-scheme:dark){body{background:#0a0a0a;color:#e4e4e7}}
main{max-width:34rem;padding:2rem}
h1{font-size:1.125rem;margin:0 0 .5rem;font-weight:600}
p{margin:.25rem 0;color:#71717a}
pre{margin-top:1rem;padding:.75rem;border-radius:.375rem;background:#f4f4f5;
  overflow-x:auto;font-size:12px;line-height:1.5;color:#3f3f46}
@media(prefers-color-scheme:dark){pre{background:#18181b;color:#a1a1aa}}
a{color:inherit}
.dot{display:inline-block;width:.5rem;height:.5rem;border-radius:50%;margin-right:.5rem;
  background:currentColor;animation:p 1.4s ease-in-out infinite}
@keyframes p{0%,100%{opacity:.3}50%{opacity:1}}
</style></head>
<body><main>${o.body}</main></body></html>`;
  return new Response(html, {
    status: o.status,
    // gangway's own pages are served on preview hostnames, unlisted ones included:
    // "building", "failed" and "not found" are not things to index under somebody's URL.
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

/** 202, not 502: the stack is coming up and the browser should come back. */
export function buildingPage(hostname: string, logUrl?: string): Response {
  return page({
    status: 202,
    refreshSeconds: 5,
    title: `Building ${hostname}`,
    heading: "Building",
    body: `<h1><span class="dot"></span>Building this preview</h1>
<p>${escapeHtml(hostname)}</p>
<p>This page refreshes every 5 seconds.</p>
${logUrl ? `<p><a href="${escapeHtml(logUrl)}">View the build log</a></p>` : ""}`,
  });
}

/** Waking from idle sleep. Same shape as building; the visitor need not care which. */
export function wakingPage(hostname: string): Response {
  return page({
    status: 202,
    refreshSeconds: 3,
    title: `Waking ${hostname}`,
    heading: "Waking",
    body: `<h1><span class="dot"></span>Waking this preview</h1>
<p>${escapeHtml(hostname)}</p>
<p>It was asleep to save resources. This usually takes a few seconds.</p>`,
  });
}

export function failedPage(hostname: string, logLines: string[] = [], logUrl?: string): Response {
  const tail = logLines.slice(-50);
  return page({
    status: 502,
    title: `Failed ${hostname}`,
    heading: "Failed",
    body: `<h1>This preview failed to start</h1>
<p>${escapeHtml(hostname)}</p>
${tail.length ? `<pre>${escapeHtml(tail.join("\n"))}</pre>` : ""}
${logUrl ? `<p><a href="${escapeHtml(logUrl)}">View the full log</a></p>` : ""}`,
  });
}

export function unknownPage(hostname: string): Response {
  return page({
    status: 404,
    title: "No such preview",
    heading: "Not found",
    body: `<h1>No such preview</h1>
<p>Nothing is served at ${escapeHtml(hostname)}.</p>
<p>It may have been destroyed, or its time-to-live may have expired.</p>`,
  });
}

export function upstreamTimeoutPage(hostname: string): Response {
  return page({
    status: 504,
    title: "Timed out",
    heading: "Timed out",
    body: `<h1>The preview did not respond in time</h1><p>${escapeHtml(hostname)}</p>`,
  });
}

export function badGatewayPage(hostname: string): Response {
  return page({
    status: 502,
    title: "Unreachable",
    heading: "Unreachable",
    body: `<h1>The preview is not reachable</h1>
<p>${escapeHtml(hostname)}</p>
<p>Its container may have stopped.</p>`,
  });
}

export function busyPage(hostname: string): Response {
  return page({
    status: 503,
    title: "Too busy",
    heading: "Too busy",
    body: `<h1>This preview is handling too many requests</h1><p>${escapeHtml(hostname)}</p>`,
  });
}

export function payloadTooLargePage(): Response {
  return page({
    status: 413,
    title: "Too large",
    heading: "Too large",
    body: `<h1>That upload is too large</h1><p>The request exceeded this preview's body limit.</p>`,
  });
}

/** 421: the Host header is not under our base domain, so we are not the right server. */
export function misdirectedPage(): Response {
  return page({
    status: 421,
    title: "Misdirected",
    heading: "Misdirected",
    body: `<h1>Misdirected request</h1><p>This server does not serve that hostname.</p>`,
  });
}
