import {
  bounds,
  CANVAS_GAP,
  connector,
  fit,
  FRAME_WIDTH,
  layoutFrames,
  type Box,
  type CanvasLayout,
} from "@gangway/shared/artifact/canvas";
import { rootSettings } from "./elements.ts";
import { svg } from "./flow-draw.ts";
import { esc } from "./md.ts";

const MIN = 0.05;
const MAX = 4;
const MAP_W = 180;
const MAP_H = 120;
const INTERACTIVE = "a,button,input,select,textarea,summary,label,[contenteditable],gw-flow svg";

type View = { k: number; x: number; y: number };

const num = (v: string | null, d?: number) => {
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

/** A board of frames the reader pans and zooms. */
class Canvas extends HTMLElement {
  #view: View = { k: 1, x: 0, y: 0 };
  #boxes = new Map<string, Box>();
  #world!: HTMLElement;
  #port!: HTMLElement;
  #links!: SVGSVGElement;
  #map!: SVGSVGElement;
  #zoom!: HTMLElement;
  #frames: HTMLElement[] = [];
  #fitted = false;

  connectedCallback() {
    if (this.dataset["ready"]) return;
    this.dataset["ready"] = "1";
    rootSettings(this);
    queueMicrotask(() => this.#build());
  }

  #build() {
    this.#frames = [...this.querySelectorAll<HTMLElement>(":scope > gw-frame")];
    this.#port = document.createElement("div");
    this.#port.dataset["part"] = "viewport";
    this.#port.tabIndex = 0;
    this.#port.setAttribute("aria-label", "Canvas: drag to pan, pinch or ctrl+scroll to zoom");
    this.#world = document.createElement("div");
    this.#world.dataset["part"] = "world";
    this.#links = svg("svg", { "data-part": "links", "aria-hidden": "true" });
    this.#links.innerHTML =
      '<defs><marker id="gw-canvas-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>';
    this.#world.append(this.#links, ...this.#frames.map((f) => this.#dress(f)));
    this.#port.append(this.#world);
    this.replaceChildren(this.#head(), this.#port, this.#controls(), this.#minimap());
    this.#listen();
    if (innerWidth < 640) this.classList.add("gw-list");
    this.#layout();
    void document.fonts?.ready.then(() => this.#layout());
    for (const img of this.querySelectorAll("img"))
      img.addEventListener("load", () => this.#layout(), { once: true });
    const sized = new ResizeObserver(() => this.#layout());
    for (const f of this.#frames) sized.observe(f);
    new ResizeObserver(() => {
      this.#shrink();
      this.#paint();
    }).observe(this.#port);
  }

  /** In the list, a desktop window wider than the page is scaled down whole, not cut off. */
  #shrink() {
    const list = this.classList.contains("gw-list");
    const room = this.#port.clientWidth - 32;
    for (const f of this.#frames) {
      if (f.getAttribute("frame") !== "window") continue;
      const w = num(f.getAttribute("w"), FRAME_WIDTH)!;
      f.style.zoom = list && room > 0 && room < w ? String(room / w) : "";
    }
  }

  #head(): HTMLElement {
    const h = document.createElement("header");
    h.className = "gw-canvas-head";
    const sub = this.getAttribute("subtitle");
    h.innerHTML =
      `<div class="gw-canvas-top"><span class="gw-logo" aria-hidden="true"></span><span class="gw-caps">${esc(this.getAttribute("label") ?? "Canvas")}</span></div>` +
      `<h1>${esc(this.getAttribute("title") ?? "")}</h1>` +
      (sub ? `<p>${esc(sub)}</p>` : "");
    return h;
  }

  #dress(f: HTMLElement): HTMLElement {
    const body = document.createElement("div");
    body.className = "gw-frame-body";
    const links = [...f.querySelectorAll(":scope > gw-link")];
    const content = [...f.childNodes].filter((n) => !links.includes(n as Element));
    if (f.getAttribute("frame") === "window") {
      // A desktop window: a title bar with its address, then the page.
      const bar = document.createElement("div");
      bar.className = "gw-window-bar";
      bar.setAttribute("aria-hidden", "true");
      const url = f.getAttribute("url");
      bar.innerHTML = `<i></i><i></i><i></i>${url ? `<span>${esc(url)}</span>` : ""}`;
      const view = document.createElement("div");
      view.className = "gw-window-view";
      view.append(...content);
      body.append(bar, view);
    } else body.append(...content);
    const label = document.createElement("div");
    label.className = "gw-frame-label";
    const title = f.getAttribute("title") ?? f.id;
    label.innerHTML = `<a href="#${esc(f.id)}">${esc(title)}</a>`;
    f.replaceChildren(label, body, ...links);
    f.style.width = `${num(f.getAttribute("w"), FRAME_WIDTH)}px`;
    const h = num(f.getAttribute("h"));
    if (h !== undefined) f.style.height = `${h}px`;
    return f;
  }

  #controls(): HTMLElement {
    const c = document.createElement("div");
    c.dataset["part"] = "controls";
    c.innerHTML =
      '<button type="button" data-do="out" aria-label="Zoom out">−</button>' +
      '<button type="button" data-do="one" class="gw-zoom" title="Actual size (1)">100%</button>' +
      '<button type="button" data-do="in" aria-label="Zoom in">+</button>' +
      '<button type="button" data-do="fit" title="Fit everything (0)">Fit</button>' +
      '<button type="button" data-do="list" title="Frames one under another">List</button>' +
      (this.#frames.length > 1
        ? `<select aria-label="Go to a frame"><option value="">Frames</option>${this.#frames
            .map(
              (f) =>
                `<option value="${esc(f.id)}">${esc(f.getAttribute("title") ?? f.id)}</option>`,
            )
            .join("")}</select>`
        : "");
    this.#zoom = c.querySelector(".gw-zoom")!;
    c.addEventListener("click", (e) => {
      const act = (e.target as Element).closest<HTMLElement>("[data-do]")?.dataset["do"];
      if (act === "in") this.#zoomBy(1.25);
      else if (act === "out") this.#zoomBy(0.8);
      else if (act === "one") this.#zoomBy(1 / this.#view.k);
      else if (act === "fit") this.#fit(true);
      else if (act === "list") {
        this.classList.toggle("gw-list");
        this.#shrink();
      }
    });
    c.querySelector("select")?.addEventListener("change", (e) => {
      const id = (e.target as HTMLSelectElement).value;
      if (id) location.hash = id;
    });
    return c;
  }

  #minimap(): HTMLElement {
    const m = document.createElement("div");
    m.dataset["part"] = "map";
    this.#map = svg("svg", { width: MAP_W, height: MAP_H, "aria-hidden": "true" }, m);
    m.addEventListener("pointerdown", (e) => {
      const world = bounds(this.#boxes.values());
      const s = Math.min(MAP_W / world.w, MAP_H / world.h);
      const r = this.#map.getBoundingClientRect();
      const wx = world.x + (e.clientX - r.left - (MAP_W - world.w * s) / 2) / s;
      const wy = world.y + (e.clientY - r.top - (MAP_H - world.h * s) / 2) / s;
      const { k } = this.#view;
      this.#set(
        { k, x: this.#port.clientWidth / 2 - wx * k, y: this.#port.clientHeight / 2 - wy * k },
        true,
      );
    });
    return m;
  }

  #layout() {
    const specs = this.#frames.map((f) => ({
      id: f.id,
      w: f.offsetWidth,
      h: f.offsetHeight,
      x: num(f.getAttribute("x")),
      y: num(f.getAttribute("y")),
    }));
    if (specs.some((s) => s.w === 0)) return;
    this.#boxes = layoutFrames(specs, {
      layout: (this.getAttribute("layout") as CanvasLayout | null) ?? "grid",
      columns:
        num(this.getAttribute("columns"), Math.min(4, Math.ceil(Math.sqrt(specs.length)))) ?? 3,
      gap: num(this.getAttribute("gap"), CANVAS_GAP) ?? CANVAS_GAP,
    });
    for (const f of this.#frames) {
      const b = this.#boxes.get(f.id)!;
      f.style.left = `${b.x}px`;
      f.style.top = `${b.y}px`;
    }
    this.#arrows();
    if (!this.#fitted) {
      this.#fitted = true;
      const id = decodeURIComponent(location.hash.slice(1));
      if (!this.#focus(id, false)) this.#fit(false);
    }
    this.#paint();
  }

  #arrows() {
    for (const old of this.#links.querySelectorAll("g")) old.remove();
    const world = bounds(this.#boxes.values());
    this.#links.setAttribute("width", String(world.x + world.w + 200));
    this.#links.setAttribute("height", String(world.y + world.h + 200));
    for (const f of this.#frames)
      for (const l of f.querySelectorAll(":scope > gw-link")) {
        const a = this.#boxes.get(f.id);
        const b = this.#boxes.get(l.getAttribute("to") ?? "");
        if (!a || !b) continue;
        const c = connector(a, b);
        const g = svg("g", { class: "gw-arrow" }, this.#links);
        svg("path", { d: c.d, "marker-end": "url(#gw-canvas-arrow)" }, g);
        const text = l.getAttribute("label");
        if (text) {
          const t = svg("text", { x: c.mid.x, y: c.mid.y }, g);
          t.textContent = text;
          const w = t.getComputedTextLength?.() || text.length * 7;
          g.insertBefore(
            svg("rect", { x: c.mid.x - w / 2 - 6, y: c.mid.y - 11, width: w + 12, height: 22 }),
            t,
          );
        }
      }
  }

  #listen() {
    const port = this.#port;
    const pointers = new Map<number, { x: number; y: number }>();
    let last: { x: number; y: number; d: number } | null = null;
    port.addEventListener("pointerdown", (e) => {
      if (this.classList.contains("gw-list")) return;
      if ((e.target as Element).closest(INTERACTIVE) && e.button === 0 && pointers.size === 0)
        return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      port.setPointerCapture(e.pointerId);
      port.classList.add("grabbing");
      // A drag pans; it must not also select the text it crosses.
      document.getSelection()?.removeAllRanges();
      last = null;
    });
    port.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const ps = [...pointers.values()];
      const cx = ps.reduce((s, p) => s + p.x, 0) / ps.length;
      const cy = ps.reduce((s, p) => s + p.y, 0) / ps.length;
      const d = ps.length > 1 ? Math.hypot(ps[0]!.x - ps[1]!.x, ps[0]!.y - ps[1]!.y) : 0;
      if (last) {
        const v = { ...this.#view, x: this.#view.x + cx - last.x, y: this.#view.y + cy - last.y };
        this.#set(v, false);
        if (d && last.d) this.#zoomAt(d / last.d, cx, cy);
      }
      last = { x: cx, y: cy, d };
    });
    const end = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      last = null;
      if (pointers.size === 0) port.classList.remove("grabbing");
    };
    port.addEventListener("pointerup", end);
    port.addEventListener("pointercancel", end);
    port.addEventListener(
      "wheel",
      (e) => {
        if (this.classList.contains("gw-list")) return;
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) this.#zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
        else
          this.#set(
            { ...this.#view, x: this.#view.x - e.deltaX, y: this.#view.y - e.deltaY },
            false,
          );
      },
      { passive: false },
    );
    window.addEventListener("keydown", (e) => this.#key(e));
    window.addEventListener("hashchange", () =>
      this.#focus(decodeURIComponent(location.hash.slice(1)), true),
    );
  }

  #key(e: KeyboardEvent) {
    if (e.target instanceof Element && e.target.closest("input,textarea,select")) return;
    const pan = (x: number, y: number) =>
      this.#set({ ...this.#view, x: this.#view.x + x, y: this.#view.y + y }, true);
    if (e.key === "+" || e.key === "=") this.#zoomBy(1.25);
    else if (e.key === "-") this.#zoomBy(0.8);
    else if (e.key === "0" || e.key === "Escape") this.#fit(true);
    else if (e.key === "1") this.#zoomBy(1 / this.#view.k);
    else if (e.key === "ArrowLeft") pan(80, 0);
    else if (e.key === "ArrowRight") pan(-80, 0);
    else if (e.key === "ArrowUp") pan(0, 80);
    else if (e.key === "ArrowDown") pan(0, -80);
    else return;
    e.preventDefault();
  }

  #zoomBy(f: number) {
    const r = this.#port.getBoundingClientRect();
    this.#zoomAt(f, r.left + r.width / 2, r.top + r.height / 2, true);
  }

  #zoomAt(f: number, cx: number, cy: number, animate = false) {
    const r = this.#port.getBoundingClientRect();
    const { k, x, y } = this.#view;
    const k2 = Math.min(MAX, Math.max(MIN, k * f));
    const px = cx - r.left;
    const py = cy - r.top;
    this.#set({ k: k2, x: px - ((px - x) / k) * k2, y: py - ((py - y) / k) * k2 }, animate);
  }

  /** Fits `box` into the part of the viewport below the title card and above the controls. */
  #fitBox(box: Box, margin: number, limits: [number, number], animate: boolean) {
    const top = (this.querySelector<HTMLElement>(".gw-canvas-head")?.offsetHeight ?? 0) + 16;
    const view = {
      w: this.#port.clientWidth,
      h: Math.max(200, this.#port.clientHeight - top - 64),
    };
    const v = fit(box, view, margin, limits);
    this.#set({ ...v, y: v.y + top }, animate);
  }

  #fit(animate: boolean) {
    this.#fitBox(bounds(this.#boxes.values()), 48, [MIN, 1], animate);
  }

  #focus(id: string, animate: boolean): boolean {
    const b = id ? this.#boxes.get(id) : undefined;
    if (!b) return false;
    this.#fitBox({ x: b.x, y: b.y - 32, w: b.w, h: b.h + 32 }, 32, [MIN, 1.5], animate);
    return true;
  }

  #set(v: View, animate: boolean) {
    this.#view = v;
    this.#world.classList.toggle("animating", animate);
    this.#paint();
  }

  #paint() {
    const { k, x, y } = this.#view;
    this.#world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    // The 16px grid goes when it would be denser than the eye can read.
    const fine = 16 * k < 8 ? 80 * k : 16 * k;
    this.#port.style.backgroundSize = `${80 * k}px ${80 * k}px, ${80 * k}px ${80 * k}px, ${fine}px ${fine}px, ${fine}px ${fine}px`;
    this.#port.style.backgroundPosition = `${x}px ${y}px`;
    this.#zoom.textContent = `${Math.round(k * 100)}%`;
    this.#paintMap();
  }

  #paintMap() {
    const world = bounds(this.#boxes.values());
    if (world.w === 0) return;
    const s = Math.min(MAP_W / world.w, MAP_H / world.h);
    const ox = (MAP_W - world.w * s) / 2 - world.x * s;
    const oy = (MAP_H - world.h * s) / 2 - world.y * s;
    const { k, x, y } = this.#view;
    const rects = [...this.#boxes.values()]
      .map(
        (b) =>
          `<rect class="f" x="${ox + b.x * s}" y="${oy + b.y * s}" width="${b.w * s}" height="${b.h * s}"/>`,
      )
      .join("");
    const vw = this.#port.clientWidth / k;
    const vh = this.#port.clientHeight / k;
    this.#map.innerHTML = `${rects}<rect class="v" x="${ox + (-x / k) * s}" y="${oy + (-y / k) * s}" width="${vw * s}" height="${vh * s}"/>`;
  }
}

export function defineCanvas(): void {
  const defs: [string, CustomElementConstructor][] = [
    ["gw-canvas", Canvas],
    ["gw-frame", class extends HTMLElement {}],
    ["gw-link", class extends HTMLElement {}],
  ];
  for (const [name, cls] of defs) if (!customElements.get(name)) customElements.define(name, cls);
}
