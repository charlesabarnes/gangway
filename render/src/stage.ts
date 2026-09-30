import { must } from "@gangway/shared/must";
import { rootSettings } from "./elements.ts";
import { esc } from "./md.ts";
import { Prototype } from "./prototype.ts";

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
  if (n > 0) {
    body.dataset["n"] = pad(n);
  }
  body.append(...[...s.childNodes].filter((n) => n !== notes));
  if (s.getAttribute("layout") === "section" && s.hasAttribute("eyebrow")) {
    body.insertAdjacentHTML(
      "afterbegin",
      `<span class="gw-caps">${esc(s.getAttribute("eyebrow") ?? "")}</span>`,
    );
  }
  const layout = s.getAttribute("layout") ?? "";
  const titled = TITLED.has(layout) && body.firstElementChild?.localName === "h2";
  // A statement in the sidebar look carries its section in the column, which is otherwise empty.
  const sidedStatement = layout === "statement" && look === "sidebar";
  if ((titled || sidedStatement) && section) {
    body.insertAdjacentHTML("afterbegin", `<span class="gw-kicker gw-caps">${esc(section)}</span>`);
  }
  if (titled && look === "sidebar") {
    sidebar(body, body.querySelector(":scope > h2"));
  } else if (sidedStatement) {
    sidebar(body, body.querySelector(":scope > .gw-kicker"));
  }
  if (layout === "quote") {
    splitCite(body);
  }
  s.replaceChildren(body, ...(notes ? [notes] : []));
  s.style.setProperty("--progress", String((i + 1) / total));
  s.insertAdjacentHTML(
    "beforeend",
    `<div class="gw-slide-foot"><span><span class="gw-logo" aria-hidden="true"></span><span class="gw-caps">${esc(footer)}</span></span><span class="gw-meta">${pad(i + 1)} / ${pad(total)}</span></div><div class="gw-slide-progress" aria-hidden="true"></div>`,
  );
}

/** Each slide in its body, footer and progress, with its section's name where it has a title. */
function dressAll(slides: HTMLElement[], footer: string, look: string): void {
  let sections = 0;
  let section = "";
  slides.forEach((s, i) => {
    const divider = s.getAttribute("layout") === "section";
    if (divider) {
      section = s.querySelector("h1, h2")?.textContent.trim() ?? "";
    }
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
}

/** The sidebar look: the kicker and title (up to `last`) in a column, the rest beside it. */
function sidebar(body: HTMLElement, last: Element | null): void {
  const head = document.createElement("div");
  head.className = "gw-slide-head";
  const main = document.createElement("div");
  main.className = "gw-slide-main";
  if (last) {
    head.append(...[...body.children].slice(0, [...body.children].indexOf(last) + 1));
  }
  main.append(...body.childNodes);
  body.classList.add("gw-sided");
  body.append(head, main);
}

/** Where a `— Name` line starts: the first newline in the blank run before a dash and a space, or -1. */
function citeAt(text: string): number {
  for (const m of text.matchAll(/[—–]\s/g)) {
    let start = m.index;
    while (start > 0 && /\s/.test(text.charAt(start - 1))) {
      start--;
    }
    const nl = text.indexOf("\n", start);
    if (nl !== -1 && nl < m.index) {
      return nl;
    }
  }
  return -1;
}

/** Markdown joins a quote and its `> — Name, role` line; this splits them into two paragraphs. */
function splitCite(body: HTMLElement): void {
  const p = body.querySelector("blockquote > p:only-of-type");
  if (!p?.lastChild) {
    return;
  }
  const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  for (let t = w.nextNode() as Text | null; t; t = w.nextNode() as Text | null) {
    const at = citeAt(t.data);
    if (at === -1) {
      continue;
    }
    const r = document.createRange();
    r.setStart(t, at);
    r.setEndAfter(p.lastChild);
    const cite = document.createElement("p");
    cite.append(r.extractContents());
    cite.normalize();
    if (cite.firstChild instanceof Text) {
      cite.firstChild.data = cite.firstChild.data.trimStart();
    }
    p.after(cite);
    return;
  }
}

/** Shrinks a slide's numbers together until the longest word in each fits its column. */
function fitNumbers(s: HTMLElement): void {
  if (s.dataset["fitted"] || !s.offsetWidth) {
    return;
  }
  const values = [...s.querySelectorAll<HTMLElement>('gw-stat [data-part="value"]')];
  if (document.fonts.status !== "loaded") {
    return;
  }
  s.dataset["fitted"] = "1";
  const [first] = values;
  if (!first) {
    return;
  }
  // A value grows to its widest word, so it is measured against the room inside its padding.
  const sized = values.map((v) => {
    const stat = must(v.closest("gw-stat"), "the stat around a value");
    const t = getComputedStyle(stat);
    return {
      v,
      room: stat.clientWidth - Number.parseFloat(t.paddingLeft) - Number.parseFloat(t.paddingRight),
    };
  });
  const over = () => sized.some(({ v, room }) => v.scrollWidth > room + 1);
  let size = Number.parseFloat(getComputedStyle(first).fontSize);
  while (over() && size > 24) {
    size -= 2;
    for (const v of values) {
      v.style.fontSize = `${size}px`;
    }
  }
}

class Deck extends HTMLElement {
  #at = 0;

  connectedCallback() {
    if (this.dataset["ready"]) {
      return;
    }
    this.dataset["ready"] = "1";
    rootSettings(this);
    queueMicrotask(() => {
      this.#build();
    });
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
    dressAll(slides, footer, this.getAttribute("look") ?? "classic");
    const [prev, count, next, pdf, full] = [...nav.children] as [
      HTMLButtonElement,
      HTMLElement,
      HTMLButtonElement,
      HTMLButtonElement,
      HTMLButtonElement,
    ];
    const fitCurrent = () => {
      const s = slides[this.#at];
      if (s) {
        fitNumbers(s);
      }
    };
    const go = (i: number) => {
      this.#at = Math.max(0, Math.min(slides.length - 1, i));
      slides.forEach((s, j) => s.classList.toggle("on", j === this.#at));
      fitCurrent();
      count.textContent = `${this.#at + 1} / ${slides.length}`;
      prev.disabled = this.#at === 0;
      next.disabled = this.#at === slides.length - 1;
      history.replaceState(null, "", `#/${this.#at + 1}`);
    };
    // Not innerWidth: a phone browser widens the page to the slide's 1280px and innerWidth follows.
    const fit = () => {
      const root = document.documentElement;
      // Full screen has no controls under the slide to leave room for.
      const nav = document.fullscreenElement ? 0 : 48;
      const k = Math.min(root.clientWidth / W, (root.clientHeight - nav) / H);
      stage.style.width = `${W * k}px`;
      stage.style.height = `${H * k}px`;
      canvas.style.transform = `scale(${k})`;
    };
    prev.onclick = () => {
      go(this.#at - 1);
    };
    next.onclick = () => {
      go(this.#at + 1);
    };
    window.addEventListener("resize", fit);
    this.#swipe(stage, go);
    this.#click(stage, go);
    pdf.onclick = () => void this.#export();
    // An iPhone has no full screen for a page, only for video; the button shows where it works.
    full.hidden = !document.fullscreenEnabled;
    full.onclick = () => {
      this.#fullscreen();
    };
    document.addEventListener("fullscreenchange", fit);
    this.#idle();
    window.addEventListener("beforeprint", () => {
      this.#drawAll();
    });
    window.addEventListener("hashchange", () => {
      const n = hashSlide();
      if (n && n - 1 !== this.#at) {
        go(n - 1);
      }
    });
    window.addEventListener("keydown", (e) => {
      this.#key(e, go);
    });
    fit();
    go(Math.max(0, hashSlide() - 1));
    void document.fonts.ready.then(fitCurrent);
  }

  #swiped = 0;

  /** A horizontal swipe on the slide turns it, as the arrow keys do. */
  #swipe(stage: HTMLElement, go: (i: number) => void) {
    let x = 0;
    let y = 0;
    stage.addEventListener(
      "touchstart",
      (e) => {
        const t = e.touches[0];
        if (t) {
          ({ clientX: x, clientY: y } = t);
        }
      },
      { passive: true },
    );
    stage.addEventListener("touchend", (e) => {
      const t = e.changedTouches[0];
      if (!t) {
        return;
      }
      const dx = t.clientX - x;
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(t.clientY - y)) {
        return;
      }
      this.#swiped = Date.now();
      go(this.#at + (dx < 0 ? 1 : -1));
    });
  }

  /** Click advances, shift-click goes back; links, controls and text selection keep the click. */
  #click(stage: HTMLElement, go: (i: number) => void) {
    let x = 0;
    let y = 0;
    stage.addEventListener("mousedown", (e) => {
      ({ clientX: x, clientY: y } = e);
      // Shift would extend a text selection rather than go back.
      if (e.shiftKey) {
        e.preventDefault();
      }
    });
    stage.addEventListener("click", (e) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest("a, button, input, select, textarea, label, summary, [data-go], .acts")) {
        return;
      }
      const dragged = Math.hypot(e.clientX - x, e.clientY - y) > 5;
      if (dragged || Date.now() - this.#swiped < 500) {
        return;
      }
      go(this.#at + (e.shiftKey ? -1 : 1));
    });
  }

  /** In full screen the pointer hides once it has been still for two seconds. */
  #idle() {
    let timer = 0;
    document.addEventListener("mousemove", () => {
      this.classList.remove("idle");
      clearTimeout(timer);
      if (document.fullscreenElement) {
        timer = window.setTimeout(() => {
          this.classList.add("idle");
        }, 2000);
      }
    });
  }

  #fullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen().catch(() => {});
    }
  }

  /** Lays every slide out, out of sight, so charts on slides not yet shown get drawn. */
  #drawAll() {
    this.classList.add("gw-laying-out");
    for (const s of this.querySelectorAll<HTMLElement>("gw-slide")) {
      fitNumbers(s);
    }
    for (const f of this.querySelectorAll("gw-flow")) {
      f.classList.add("drawn");
    }
  }

  /** The browser's print dialog, where "Save as PDF" makes one 16:9 page a slide. */
  async #export() {
    this.#drawAll();
    // Charts draw on the resize their layout causes; two frames and a moment let them.
    for (let i = 0; i < 2; i++) {
      await new Promise(requestAnimationFrame);
    }
    await new Promise((r) => setTimeout(r, 200));
    window.addEventListener(
      "afterprint",
      () => {
        this.classList.remove("gw-laying-out");
      },
      {
        once: true,
      },
    );
    print();
  }

  #key(e: KeyboardEvent, go: (i: number) => void) {
    if (e.target instanceof Element && e.target.closest("input,textarea,select")) {
      return;
    }
    if (["ArrowRight", "PageDown", " "].includes(e.key)) {
      go(this.#at + 1);
    } else if (["ArrowLeft", "PageUp"].includes(e.key)) {
      go(this.#at - 1);
    } else if (e.key === "Home") {
      go(0);
    } else if (e.key === "End") {
      go(Number.MAX_SAFE_INTEGER);
    } else if (e.key === "n") {
      this.classList.toggle("notes");
    } else if (e.key === "f" && document.fullscreenEnabled) {
      this.#fullscreen();
    } else {
      return;
    }
    e.preventDefault();
  }
}

export function defineStage(): void {
  const defs: [string, CustomElementConstructor][] = [
    ["gw-deck", Deck],
    ["gw-prototype", Prototype],
    ["gw-slide", class extends HTMLElement {}],
    ["gw-screen", class extends HTMLElement {}],
  ];
  for (const [name, cls] of defs) {
    if (!customElements.get(name)) {
      customElements.define(name, cls);
    }
  }
}
