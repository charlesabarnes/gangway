import { rootSettings } from "./elements.ts";
import { esc } from "./md.ts";

type Templated = Text & { gwTemplate?: string };

function templated(root: Element): Templated[] {
  const out: Templated[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode() as Templated | null; n; n = w.nextNode() as Templated | null) {
    if (n.gwTemplate !== undefined || (n.nodeValue ?? "").includes("{{")) {
      out.push(n);
    }
  }
  return out;
}

export class Prototype extends HTMLElement {
  #state: Record<string, string | boolean> = {};

  connectedCallback() {
    if (this.dataset["ready"]) {
      return;
    }
    this.dataset["ready"] = "1";
    if (!this.hasAttribute("look")) {
      this.setAttribute("look", "app");
    }
    rootSettings(this);
    queueMicrotask(() => {
      this.#build();
    });
  }

  #build() {
    const device = document.createElement("div");
    device.dataset["part"] = "device";
    device.append(...this.childNodes);
    this.append(device);
    const screens = [...device.querySelectorAll<HTMLElement>("gw-screen")];
    for (const s of screens) {
      const back = s.getAttribute("back");
      if (s.hasAttribute("title")) {
        s.insertAdjacentHTML(
          "afterbegin",
          `<header>${back ? `<a href="#${esc(back)}" aria-label="Back">←</a>` : "<span></span>"}<span class="gw-caps">${esc(s.getAttribute("title") ?? "")}</span><span></span></header>`,
        );
      }
      for (const n of templated(s)) {
        n.gwTemplate ??= n.nodeValue ?? "";
      }
    }
    for (const input of device.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      "input[name],select[name],textarea[name]",
    )) {
      const read = () =>
        (this.#state[input.name] =
          input instanceof HTMLInputElement && input.type === "checkbox"
            ? input.checked
            : input.value);
      read();
      input.addEventListener("input", read);
      input.addEventListener("change", read);
    }
    device.addEventListener("click", (e) => {
      const b = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-go]") : null;
      if (b?.dataset["go"]) {
        location.hash = b.dataset["go"];
      }
    });
    const show = () => {
      const id = [
        decodeURIComponent(location.hash.slice(1)),
        this.getAttribute("start"),
        screens[0]?.id,
      ].find(Boolean);
      const target = screens.find((s) => s.id === id) ?? screens[0];
      for (const s of screens) {
        s.classList.toggle("on", s === target);
      }
      for (const a of device.querySelectorAll("gw-tabs a")) {
        if (a.getAttribute("href") === `#${target?.id}`) {
          a.setAttribute("aria-current", "page");
        } else {
          a.removeAttribute("aria-current");
        }
      }
      if (target) {
        for (const n of templated(target)) {
          n.nodeValue = (n.gwTemplate ?? "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) =>
            String(this.#state[k] ?? ""),
          );
        }
      }
      device.scrollTop = 0;
    };
    window.addEventListener("hashchange", show);
    show();
  }
}
