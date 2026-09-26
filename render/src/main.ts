import { defineCanvas } from "./canvas.ts";
import { applyTheme, chrome } from "./chrome.ts";
import { defineElements, problem } from "./elements.ts";
import { defineFlow } from "./flow.ts";
import { compile } from "./md.ts";
import { defineStage } from "./stage.ts";

const ROOTS = "gw-doc,gw-deck,gw-canvas,gw-dashboard,gw-prototype";
const LEGACY = "gw-dashboard,gw-prototype";
const base = new URL(".", import.meta.url).pathname;

/** A stylesheet beside the kit, once: the page's theme, or the retired kinds' styles. */
function sheet(name: string): void {
  if (document.querySelector(`link[href^="${base}${name}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `${base}${name}`;
  const kit = document.querySelector(`link[href*="kit.css"]`);
  if (kit) kit.after(link);
  else document.head.append(link);
}

async function markdown(): Promise<string | null> {
  const inline = document.querySelector('script[type="text/markdown"]')?.textContent;
  if (inline) return inline;
  const res = await fetch("/artifact.md", { cache: "no-cache" });
  return res.ok ? res.text() : null;
}

async function boot(): Promise<void> {
  applyTheme();
  sheet("theme.css");
  defineElements();
  defineFlow();
  defineStage();
  defineCanvas();
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
  if (document.querySelector(LEGACY)) sheet("legacy.css");
  chrome();
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", () => void boot());
else void boot();
