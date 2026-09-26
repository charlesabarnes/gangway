import { applyTheme, chrome } from "./chrome.ts";
import { defineElements, problem } from "./elements.ts";
import { defineFlow } from "./flow.ts";
import { compile } from "./md.ts";
import { defineStage } from "./stage.ts";

const ROOTS = "gw-doc,gw-dashboard,gw-deck,gw-prototype";

async function markdown(): Promise<string | null> {
  const inline = document.querySelector('script[type="text/markdown"]')?.textContent;
  if (inline) return inline;
  const res = await fetch("/artifact.md", { cache: "no-cache" });
  return res.ok ? res.text() : null;
}

async function boot(): Promise<void> {
  applyTheme();
  defineElements();
  defineFlow();
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
  chrome();
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", () => void boot());
else void boot();
