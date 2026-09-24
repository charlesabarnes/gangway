import { applyTheme, chrome } from "./chrome.ts";
import { defineElements, problem } from "./elements.ts";
import { compile } from "./md.ts";
import { defineStage } from "./stage.ts";

const ROOTS = "gw-doc,gw-dashboard,gw-deck,gw-prototype";
const base = new URL(".", import.meta.url).pathname;

async function markdown(): Promise<string | null> {
  const inline = document.querySelector('script[type="text/markdown"]')?.textContent;
  if (inline) return inline;
  const res = await fetch("/artifact.md", { cache: "no-cache" });
  return res.ok ? res.text() : null;
}

async function boot(): Promise<void> {
  applyTheme();
  defineElements();
  defineStage();
  if (!document.querySelector(ROOTS)) {
    const src = await markdown();
    if (src !== null) {
      try {
        document.body.insertAdjacentHTML("afterbegin", compile(src));
      } catch (err) {
        problem(document.body, `artifact.md: ${(err as Error).message}`);
      }
    }
  }
  chrome(base, await showBrand());
}

/** gangway writes config.json beside the kit; a preview or the server's setting can turn the mark off. */
async function showBrand(): Promise<boolean> {
  try {
    const res = await fetch(`${base}config.json`, { cache: "no-cache" });
    if (!res.ok) return true;
    const c = (await res.json()) as { brand?: unknown };
    return c.brand !== false;
  } catch {
    return true;
  }
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", () => void boot());
else void boot();
