import { escapeHtml } from "../util/html.ts";
import { BRAND, CHART_CSS, FAVICON_LINK, fontFaces } from "./page-chrome.ts";

type PageOpts = {
  title: string;
  heading: string;
  body: string;
  refreshSeconds?: number;
  status: number;
  /** The preview host the page stands in for; its app host serves the fonts. */
  hostname?: string;
};

type Tone = "busy" | "bad" | "plain";

function page(o: PageOpts & { label: string; tone?: Tone }): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(o.title)}</title>
${FAVICON_LINK}
${o.refreshSeconds ? `<meta http-equiv="refresh" content="${o.refreshSeconds}">` : ""}
<style>${o.hostname ? fontFaces(o.hostname) : ""}${CHART_CSS}</style></head>
<body><main>${BRAND}<span class="label ${o.tone ?? "plain"}">${escapeHtml(o.label)}</span>${o.body}</main></body></html>`;
  return new Response(html, {
    status: o.status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

const host = (h: string) => `<p class="host">${escapeHtml(h)}</p>`;

export function buildingPage(hostname: string, logUrl?: string): Response {
  return page({
    hostname,
    status: 202,
    refreshSeconds: 5,
    title: `Building ${hostname}`,
    heading: "Building",
    label: "Building",
    tone: "busy",
    body: `<h1>Building this preview</h1>
${host(hostname)}
<p>This page refreshes every 5 seconds.</p>
${logUrl ? `<p><a href="${escapeHtml(logUrl)}">View the build log</a></p>` : ""}`,
  });
}

export function wakingPage(hostname: string): Response {
  return page({
    hostname,
    status: 202,
    refreshSeconds: 3,
    title: `Waking ${hostname}`,
    heading: "Waking",
    label: "Waking",
    tone: "busy",
    body: `<h1>Waking this preview</h1>
${host(hostname)}
<p>It was asleep to save resources. This usually takes a few seconds.</p>`,
  });
}

export function failedPage(hostname: string, logLines: string[] = [], logUrl?: string): Response {
  const tail = logLines.slice(-50);
  return page({
    hostname,
    status: 502,
    title: `Failed ${hostname}`,
    heading: "Failed",
    label: "Failed",
    tone: "bad",
    body: `<h1>This preview failed to start</h1>
${host(hostname)}
${tail.length ? `<pre>${escapeHtml(tail.join("\n"))}</pre>` : ""}
${logUrl ? `<p><a href="${escapeHtml(logUrl)}">View the full log</a></p>` : ""}`,
  });
}

export function unknownPage(hostname: string): Response {
  return page({
    hostname,
    status: 404,
    title: "No such preview",
    heading: "Not found",
    label: "Not found",
    body: `<h1>No such preview</h1>
<p>Nothing is served at ${escapeHtml(hostname)}.</p>
<p>It may have been destroyed, or its time-to-live may have expired.</p>`,
  });
}

export function upstreamTimeoutPage(hostname: string): Response {
  return page({
    hostname,
    status: 504,
    title: "Timed out",
    heading: "Timed out",
    label: "Timed out",
    tone: "bad",
    body: `<h1>The preview did not respond in time</h1>${host(hostname)}`,
  });
}

export function badGatewayPage(hostname: string): Response {
  return page({
    hostname,
    status: 502,
    title: "Unreachable",
    heading: "Unreachable",
    label: "Unreachable",
    tone: "bad",
    body: `<h1>The preview is not reachable</h1>
${host(hostname)}
<p>Its container may have stopped.</p>`,
  });
}

export function busyPage(hostname: string): Response {
  return page({
    hostname,
    status: 503,
    title: "Too busy",
    heading: "Too busy",
    label: "Too busy",
    tone: "bad",
    body: `<h1>This preview is handling too many requests</h1>${host(hostname)}`,
  });
}

export function payloadTooLargePage(): Response {
  return page({
    status: 413,
    title: "Too large",
    heading: "Too large",
    label: "Too large",
    tone: "bad",
    body: `<h1>That upload is too large</h1><p>The request exceeded this preview's body limit.</p>`,
  });
}

export function misdirectedPage(): Response {
  return page({
    status: 421,
    title: "Misdirected",
    heading: "Misdirected",
    label: "Misdirected",
    body: `<h1>Misdirected request</h1><p>This server does not serve that hostname.</p>`,
  });
}
