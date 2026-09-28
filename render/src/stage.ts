import { rootSettings } from "./elements.ts";
import { esc } from "./md.ts";

const W = 1280;
const H = 720;
const pad = (n: number) => String(n).padStart(2, "0");
const hashSlide = () => Number(/^#\/(\d+)/.exec(location.hash)?.[1] ?? 0);

/** Layouts that open with a `##` title: the current section's name goes above it. */
const TITLED = new Set(["", "split", "agenda", "stats", "compare", "steps", "cards"]);

type Place = {
  i: number;
  total: number;
  footer: string;
  n: number;
  section: string;
  look: string;
};

function dress(s: HTMLElement, { i, total, footer, n, section, look }: Place): void {
  const notes = s.querySelector(":scope > aside.notes");
  const body = document.createElement("div");
  body.className = "gw-slide-body";
  if (n > 0) body.dataset["n"] = pad(n);
  body.append(...[...s.childNodes].filter((n) => n !== notes));
  if (s.getAttribute("layout") === "section" && s.hasAttribute("eyebrow"))
    body.insertAdjacentHTML(
      "afterbegin",
      `<span class="gw-caps">${esc(s.getAttribute("eyebrow") ?? "")}</span>`,
    );
  const titled =
    TITLED.has(s.getAttribute("layout") ?? "") && body.firstElementChild?.localName === "h2";
  if (titled && section)
    body.insertAdjacentHTML("afterbegin", `<span class="gw-kicker gw-caps">${esc(section)}</span>`);
  if (titled && look === "sidebar") sidebar(body);
  s.replaceChildren(body, ...(notes ? [notes] : []));
  s.style.setProperty("--progress", String((i + 1) / total));
  s.insertAdjacentHTML(
    "beforeend",
    `<div class="gw-slide-foot"><span><span class="gw-logo" aria-hidden="true"></span><span class="gw-caps">${esc(footer)}</span></span><span class="gw-meta">${pad(i + 1)} / ${pad(total)}</span></div><div class="gw-slide-progress" aria-hidden="true"></div>`,
  );
}

/** The sidebar look: the kicker and title in a column, the rest beside it. */
function sidebar(body: HTMLElement): void {
  const head = document.createElement("div");
  head.className = "gw-slide-head";
  const main = document.createElement("div");
  main.className = "gw-slide-main";
  const h2 = body.querySelector(":scope > h2")!;
  head.append(...[...body.children].slice(0, [...body.children].indexOf(h2) + 1));
  main.append(...body.childNodes);
  body.classList.add("gw-sided");
  body.append(head, main);
}

class Deck extends HTMLElement {
  #at = 0;

  connectedCallback() {
    if (this.dataset["ready"]) return;
    this.dataset["ready"] = "1";
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
    nav.innerHTML = `<button type="button" aria-label="Previous slide">←</button><span></span><button type="button" aria-label="Next slide">→</button><button type="button" class="gw-export" title="Save as PDF, one slide a page">PDF</button><button type="button" class="gw-full" aria-label="Full screen" title="Full screen (f)">⛶</button>`;
    this.replaceChildren(stage, nav);
    const footer = this.getAttribute("footer") ?? this.getAttribute("title") ?? "";
    const look = this.getAttribute("look") ?? "classic";
    let sections = 0;
    let section = "";
    slides.forEach((s, i) => {
      const divider = s.getAttribute("layout") === "section";
      if (divider) section = s.querySelector("h1, h2")?.textContent?.trim() ?? "";
      const n = divider ? ++sections : 0;
      dress(s, {
        i,
        total: slides.length,
        footer,
        n,
        section: section && `${pad(sections)} · ${section}`,
        look,
      });
    });
    const [prev, count, next, pdf, full] = [...nav.children] as [
      HTMLButtonElement,
      HTMLElement,
      HTMLButtonElement,
      HTMLButtonElement,
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
    // The viewport's own size: a phone browser can widen the page to a slide's unscaled
    // 1280px, and innerWidth would then follow it and leave the slide cut off.
    const fit = () => {
      const root = document.documentElement;
      const k = Math.min(root.clientWidth / W, (root.clientHeight - 48) / H);
      stage.style.width = `${W * k}px`;
      stage.style.height = `${H * k}px`;
      canvas.style.transform = `scale(${k})`;
    };
    prev.onclick = () => go(this.#at - 1);
    next.onclick = () => go(this.#at + 1);
    window.addEventListener("resize", fit);
    this.#swipe(stage, go);
    this.#click(stage, go);
    pdf.onclick = () => void this.#export();
    // An iPhone has no full screen for a page, only for video; the button shows where it works.
    full.hidden = !document.fullscreenEnabled;
    full.onclick = () => this.#fullscreen();
    window.addEventListener("beforeprint", () => this.#drawAll());
    window.addEventListener("hashchange", () => {
      const n = hashSlide();
      if (n && n - 1 !== this.#at) go(n - 1);
    });
    window.addEventListener("keydown", (e) => this.#key(e, go));
    fit();
    go(Math.max(0, hashSlide() - 1));
  }

  #swiped = 0;

  /** A horizontal swipe on the slide turns it, as the arrow keys do. */
  #swipe(stage: HTMLElement, go: (i: number) => void) {
    let x = 0;
    let y = 0;
    stage.addEventListener("touchstart", (e) => ({ clientX: x, clientY: y } = e.touches[0]!), {
      passive: true,
    });
    stage.addEventListener("touchend", (e) => {
      const t = e.changedTouches[0]!;
      const dx = t.clientX - x;
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(t.clientY - y)) return;
      this.#swiped = Date.now();
      go(this.#at + (dx < 0 ? 1 : -1));
    });
  }

  /** A click on the slide advances it, shift-click goes back; what is itself clickable, or a
   *  drag to select text, keeps the click. */
  #click(stage: HTMLElement, go: (i: number) => void) {
    let x = 0;
    let y = 0;
    stage.addEventListener("mousedown", (e) => {
      ({ clientX: x, clientY: y } = e);
      // Shift would extend a text selection rather than go back.
      if (e.shiftKey) e.preventDefault();
    });
    stage.addEventListener("click", (e) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest("a, button, input, select, textarea, label, summary, [data-go], .acts"))
        return;
      const dragged = Math.hypot(e.clientX - x, e.clientY - y) > 5;
      if (dragged || Date.now() - this.#swiped < 500) return;
      go(this.#at + (e.shiftKey ? -1 : 1));
    });
  }

  #fullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => {});
  }

  /** Lays every slide out, out of sight, so charts on slides not yet shown get drawn. */
  #drawAll() {
    this.classList.add("gw-laying-out");
    for (const f of this.querySelectorAll("gw-flow")) f.classList.add("drawn");
  }

  /** The browser's print dialog, where "Save as PDF" makes one 16:9 page a slide. */
  async #export() {
    this.#drawAll();
    // Charts draw on the resize their layout causes; two frames and a moment let them.
    for (let i = 0; i < 2; i++) await new Promise(requestAnimationFrame);
    await new Promise((r) => setTimeout(r, 200));
    window.addEventListener("afterprint", () => this.classList.remove("gw-laying-out"), {
      once: true,
    });
    print();
  }

  #key(e: KeyboardEvent, go: (i: number) => void) {
    if (e.target instanceof Element && e.target.closest("input,textarea,select")) return;
    if (["ArrowRight", "PageDown", " "].includes(e.key)) go(this.#at + 1);
    else if (["ArrowLeft", "PageUp"].includes(e.key)) go(this.#at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(Number.MAX_SAFE_INTEGER);
    else if (e.key === "n") this.classList.toggle("notes");
    else if (e.key === "f" && document.fullscreenEnabled) this.#fullscreen();
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
