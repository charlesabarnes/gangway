import { rootSettings } from "./elements.ts";
import { esc } from "./md.ts";

const W = 1280;
const H = 720;
const pad = (n: number) => String(n).padStart(2, "0");
const hashSlide = () => Number(/^#\/(\d+)/.exec(location.hash)?.[1] ?? 0);

function dress(s: HTMLElement, i: number, total: number, footer: string): void {
  const notes = s.querySelector(":scope > aside.notes");
  const body = document.createElement("div");
  body.className = "gw-slide-body";
  body.append(...[...s.childNodes].filter((n) => n !== notes));
  if (s.getAttribute("layout") === "section" && s.hasAttribute("eyebrow"))
    body.insertAdjacentHTML(
      "afterbegin",
      `<span class="gw-caps">${esc(s.getAttribute("eyebrow") ?? "")}</span>`,
    );
  s.replaceChildren(body, ...(notes ? [notes] : []));
  s.insertAdjacentHTML(
    "beforeend",
    `<div class="gw-slide-foot"><span class="gw-caps">${esc(footer)}</span><span class="gw-meta">${pad(i + 1)} / ${pad(total)}</span></div>`,
  );
}

class Deck extends HTMLElement {
  #at = 0;

  connectedCallback() {
    if (this.dataset["ready"]) return;
    this.dataset["ready"] = "1";
    if (!this.hasAttribute("look")) this.setAttribute("look", "app");
    rootSettings(this);
    queueMicrotask(() => this.#build());
  }

  #build() {
    const slides = [...this.querySelectorAll<HTMLElement>(":scope > gw-slide")];
    const stage = document.createElement("div");
    stage.dataset["part"] = "stage";
    const canvas = document.createElement("div");
    canvas.dataset["part"] = "canvas";
    canvas.append(...slides);
    stage.append(canvas);
    const nav = document.createElement("nav");
    nav.innerHTML = `<button type="button" aria-label="Previous slide">←</button><span></span><button type="button" aria-label="Next slide">→</button>`;
    this.replaceChildren(stage, nav);
    const footer = this.getAttribute("footer") ?? this.getAttribute("title") ?? "";
    slides.forEach((s, i) => dress(s, i, slides.length, footer));
    const [prev, count, next] = [...nav.children] as [
      HTMLButtonElement,
      HTMLElement,
      HTMLButtonElement,
    ];
    const go = (i: number) => {
      this.#at = Math.max(0, Math.min(slides.length - 1, i));
      slides.forEach((s, j) => s.classList.toggle("on", j === this.#at));
      count.textContent = `${this.#at + 1} / ${slides.length}`;
      prev.disabled = this.#at === 0;
      next.disabled = this.#at === slides.length - 1;
      history.replaceState(null, "", `#/${this.#at + 1}`);
    };
    const fit = () => {
      const k = Math.min(innerWidth / W, (innerHeight - 48) / H);
      stage.style.width = `${W * k}px`;
      stage.style.height = `${H * k}px`;
      canvas.style.transform = `scale(${k})`;
    };
    prev.onclick = () => go(this.#at - 1);
    next.onclick = () => go(this.#at + 1);
    window.addEventListener("resize", fit);
    window.addEventListener("hashchange", () => {
      const n = hashSlide();
      if (n && n - 1 !== this.#at) go(n - 1);
    });
    window.addEventListener("keydown", (e) => this.#key(e, go));
    fit();
    go(Math.max(0, hashSlide() - 1));
  }

  #key(e: KeyboardEvent, go: (i: number) => void) {
    if (e.target instanceof Element && e.target.closest("input,textarea,select")) return;
    if (["ArrowRight", "PageDown", " "].includes(e.key)) go(this.#at + 1);
    else if (["ArrowLeft", "PageUp"].includes(e.key)) go(this.#at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(Number.MAX_SAFE_INTEGER);
    else if (e.key === "n") this.classList.toggle("notes");
    else return;
    e.preventDefault();
  }
}

type Templated = Text & { gwTemplate?: string };

function templated(root: Element): Templated[] {
  const out: Templated[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode() as Templated | null; n; n = w.nextNode() as Templated | null)
    if (n.gwTemplate !== undefined || (n.nodeValue ?? "").includes("{{")) out.push(n);
  return out;
}

class Prototype extends HTMLElement {
  #state: Record<string, string | boolean> = {};

  connectedCallback() {
    if (this.dataset["ready"]) return;
    this.dataset["ready"] = "1";
    if (!this.hasAttribute("look")) this.setAttribute("look", "app");
    rootSettings(this);
    queueMicrotask(() => this.#build());
  }

  #build() {
    const device = document.createElement("div");
    device.dataset["part"] = "device";
    device.append(...this.childNodes);
    this.append(device);
    const screens = [...device.querySelectorAll<HTMLElement>("gw-screen")];
    for (const s of screens) {
      const back = s.getAttribute("back");
      if (s.hasAttribute("title"))
        s.insertAdjacentHTML(
          "afterbegin",
          `<header>${back ? `<a href="#${esc(back)}" aria-label="Back">←</a>` : "<span></span>"}<span class="gw-caps">${esc(s.getAttribute("title") ?? "")}</span><span></span></header>`,
        );
      for (const n of templated(s)) n.gwTemplate ??= n.nodeValue ?? "";
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
      if (b?.dataset["go"]) location.hash = b.dataset["go"];
    });
    const show = () => {
      const id =
        decodeURIComponent(location.hash.slice(1)) || this.getAttribute("start") || screens[0]?.id;
      const target = screens.find((s) => s.id === id) ?? screens[0];
      for (const s of screens) s.classList.toggle("on", s === target);
      for (const a of device.querySelectorAll("gw-tabs a"))
        if (a.getAttribute("href") === `#${target?.id}`) a.setAttribute("aria-current", "page");
        else a.removeAttribute("aria-current");
      if (target)
        for (const n of templated(target))
          n.nodeValue = (n.gwTemplate ?? "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) =>
            String(this.#state[k] ?? ""),
          );
      device.scrollTop = 0;
    };
    window.addEventListener("hashchange", show);
    show();
  }
}

export function defineStage(): void {
  const defs: [string, CustomElementConstructor][] = [
    ["gw-deck", Deck],
    ["gw-prototype", Prototype],
    ["gw-slide", class extends HTMLElement {}],
    ["gw-screen", class extends HTMLElement {}],
  ];
  for (const [name, cls] of defs) if (!customElements.get(name)) customElements.define(name, cls);
}
