import FAVICON from "../../../web/public/favicon-preview.svg" with { type: "text" };
import LOGO from "../../../web/public/logo.svg" with { type: "text" };
import LOGO_LIGHT from "../../../web/public/logo-light.svg" with { type: "text" };

export const FAVICON_LINK = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(FAVICON.trim())}">`;

export const BRAND = `<div class="brand"><span class="mark on-light" aria-hidden="true">${LOGO}</span><span class="mark on-dark" aria-hidden="true">${LOGO_LIGHT}</span>gangway</div>`;

const FACES: [string, string, number, string][] = [
  ["IBM Plex Sans Condensed", "sans-400", 400, "normal"],
  ["IBM Plex Sans Condensed", "sans-600", 600, "normal"],
  ["IBM Plex Serif", "serif-400-italic", 400, "italic"],
  ["IBM Plex Mono", "mono-400", 400, "normal"],
  ["IBM Plex Mono", "mono-600", 600, "normal"],
];

// Fonts come from the parent of the host a page stands in for: the app apex, or the preview apex.
export const FONT_PATH = "/_gangway/fonts/";
export const appHostOf = (previewHost: string) => previewHost.split(".").slice(1).join(".");

// A host with no parent domain keeps the fallback fonts.
export function fontFaces(previewHost: string): string {
  const app = appHostOf(previewHost);
  if (!app.includes(".")) return "";
  return FACES.map(
    ([family, file, weight, style]) =>
      `@font-face{font-family:'${family}';font-weight:${weight};font-style:${style};font-display:swap;src:url(//${app}${FONT_PATH}${file}.woff2) format('woff2')}`,
  ).join("\n");
}

export function fontSrc(previewHost: string): string {
  const app = appHostOf(previewHost);
  return app.includes(".") ? `font-src ${app};` : "";
}

export const CHART_CSS = `
:root{color-scheme:light dark;--paper:oklch(0.97 0.012 85);--ink:oklch(0.27 0.06 255);--muted:oklch(0.48 0.04 255);--rule:oklch(0.84 0.025 240);--flag:oklch(0.84 0.15 88);--danger:oklch(0.55 0.19 28);--log:oklch(0.22 0.05 255);--log-fg:oklch(0.94 0.015 85)}
@media (prefers-color-scheme:dark){:root{--paper:oklch(0.2 0.035 255);--ink:oklch(0.94 0.015 85);--muted:oklch(0.72 0.03 250);--rule:oklch(0.36 0.04 250);--danger:oklch(0.62 0.18 28);--log:oklch(0.14 0.03 255)}.on-light{display:none!important}}
@media not (prefers-color-scheme:dark){.on-dark{display:none!important}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;color:var(--ink);background-color:var(--paper);background-image:linear-gradient(var(--rule) 1px,transparent 1px),linear-gradient(90deg,var(--rule) 1px,transparent 1px);background-size:80px 80px;background-position:-1px -1px;font:15px/1.5 'IBM Plex Sans Condensed','Roboto Condensed','Arial Narrow',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:520px;display:flex;flex-direction:column;gap:14px;padding:36px 40px;background:var(--paper);box-shadow:inset 0 0 0 1px var(--ink),inset 0 0 0 4px var(--paper),inset 0 0 0 5px var(--ink)}
.brand{display:flex;align-items:center;gap:10px;font:600 18px 'IBM Plex Mono',ui-monospace,Menlo,monospace;letter-spacing:-.04em;margin-bottom:6px}
.mark{display:flex}.mark svg{width:27px;height:27px}
.label{display:inline-flex;align-items:center;gap:8px;font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.label::before{content:"";width:10px;height:10px;background:var(--tone,var(--flag))}
.label.busy::before{animation:p 1.4s ease-in-out infinite}
.label.bad{--tone:var(--danger)}
@keyframes p{0%,100%{opacity:.35}50%{opacity:1}}
h1{margin:0;font:italic 400 32px/1.1 'IBM Plex Serif',Georgia,serif}
p{margin:0;color:var(--muted)}
.host{font:13px 'IBM Plex Mono',ui-monospace,Menlo,monospace;color:var(--ink);overflow-wrap:anywhere}
pre{margin:6px 0 0;padding:12px 14px;background:var(--log);color:var(--log-fg);font:12px/1.55 'IBM Plex Mono',ui-monospace,Menlo,monospace;overflow-x:auto;box-shadow:inset 3px 0 0 var(--danger)}
a{color:inherit;text-decoration-color:var(--flag);text-decoration-thickness:2px;text-underline-offset:3px}
`;
