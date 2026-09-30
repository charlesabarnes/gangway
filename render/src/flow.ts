import { must } from "@gangway/shared/must";
import { parseFlow, type FlowGraph, type FlowNode } from "@gangway/shared/artifact/flow";
import {
  layoutFlow,
  walkOrder,
  type FlowLayout,
  type PlacedNode,
  type Size,
} from "@gangway/shared/artifact/flow-layout";
import {
  draw,
  edgeLabelWidth,
  groupLabelWidth,
  plain,
  sizeFor,
  svg,
  useTheme,
  wrap,
  type Drawn,
} from "./flow-draw.ts";
import { layoutElk, loadElk } from "./flow-elk.ts";
import { problem } from "./elements.ts";
import { esc } from "./md.ts";

const STEP_MS = 1400;

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

class Flow extends HTMLElement {
  #graph: FlowGraph | null = null;
  #drawn: Drawn | null = null;
  #order: string[] = [];
  #step = -1;
  #timer = 0;
  #note: HTMLElement | null = null;
  #controls: HTMLElement | null = null;

  connectedCallback() {
    if (this.dataset["ready"]) {
      return;
    }
    this.dataset["ready"] = "1";
    const src = this.textContent;
    this.textContent = "";
    const title = this.getAttribute("title") ?? "";
    if (title) {
      this.insertAdjacentHTML(
        "beforeend",
        `<span data-part="title" class="gw-caps">${esc(title)}</span>`,
      );
    }
    const plot = document.createElement("div");
    plot.dataset["part"] = "plot";
    this.appendChild(plot);
    const note = document.createElement("div");
    note.dataset["part"] = "note";
    note.setAttribute("aria-live", "polite");
    note.hidden = true;
    this.#note = note;
    if (this.hasAttribute("play")) {
      this.#controls = this.#makeControls();
    }
    this.append(note);
    const g = parseFlow(src, 1, this.getAttribute("direction") ?? undefined);
    if (g.legend.length) {
      this.append(legend(g));
    }
    if (this.hasAttribute("caption")) {
      this.insertAdjacentHTML(
        "beforeend",
        `<p data-part="caption">${esc(this.getAttribute("caption") ?? "")}</p>`,
      );
    }

    if (g.issues.length) {
      problem(this, g.issues.map((i) => `line ${i.line}: ${i.message}`).join("; "));
      if (g.nodes.length === 0) {
        return;
      }
    }
    this.#graph = g;
    this.#order = walkOrder(g);
    void document.fonts
      .load(useTheme(this))
      .catch(() => {})
      .then(() => this.#render(g, plot, title));
  }

  /** Subgraphs need ELK; if it cannot load, the chart is drawn flat without its groups. */
  async #layout(g: FlowGraph, size: (n: FlowNode) => Size): Promise<[FlowGraph, FlowLayout]> {
    if (g.groups.length) {
      try {
        return [
          g,
          await layoutElk(
            g,
            size,
            (t, of) => (of === "group" ? groupLabelWidth(t) : edgeLabelWidth(t)),
            await loadElk(),
          ),
        ];
      } catch (err) {
        problem(
          this,
          `the layout engine did not load, so its groups are not drawn (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
    const ids = new Set(g.nodes.map((n) => n.id));
    const flat = {
      ...g,
      groups: [],
      edges: g.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
    };
    return [flat, layoutFlow(flat, size)];
  }

  disconnectedCallback() {
    clearTimeout(this.#timer);
  }

  async #render(graph: FlowGraph, plot: HTMLElement, title: string) {
    const lines = new Map(graph.nodes.map((n) => [n.id, wrap(n.label)]));
    const [g, layout] = await this.#layout(graph, (n) =>
      sizeFor(lines.get(n.id) ?? wrap(n.label), n),
    );
    const d = draw(plot, { graph: g, layout, lines, title });
    this.#drawn = d;
    this.#fit(plot, d.svg, layout);
    if (this.hasAttribute("animate")) {
      this.classList.add("animate");
    }
    this.#wire(d, layout);
    this.#reveal(d);
  }

  /**
   * Never enlarged; shrunk to the width down to 72%, then it scrolls sideways so labels stay
   * readable. On a slide it shrinks to fit the slide instead. In a document, a chart wider than
   * its column takes the whole section, title above, and may run on to the window's edge.
   */
  #fit(plot: HTMLElement, s: SVGSVGElement, layout: FlowLayout) {
    const slide = this.closest("gw-slide") !== null;
    const body = this.parentElement?.classList.contains("gw-part-body") ? this.parentElement : null;
    // Decided once: the wider section would otherwise flip it back and forth.
    if (body && layout.width > body.clientWidth) {
      this.classList.add("wide");
    }
    const size = () => {
      if (body && this.classList.contains("wide")) {
        const room = document.documentElement.clientWidth - this.getBoundingClientRect().left - 24;
        this.style.width = `${Math.max(body.clientWidth, Math.min(layout.width, room))}px`;
      }
      const avail = plot.clientWidth;
      if (avail <= 0) {
        return;
      }
      let k = Math.min(1, avail / layout.width);
      if (slide) {
        k = Math.min(k, 430 / layout.height);
      } else {
        k = Math.max(0.72, k);
      }
      s.style.width = `${layout.width * k}px`;
    };
    size();
    new ResizeObserver(size).observe(body ?? plot);
  }

  /** Draw in once the reader reaches it, rank by rank; then, with `animate`, keep it flowing. */
  #reveal(d: Drawn) {
    const show = () => {
      this.classList.add("drawn");
      if (!this.hasAttribute("animate") || reduced()) {
        return;
      }
      const last = Math.max(0, ...d.edges.map((x) => x.e.rank));
      setTimeout(
        () => {
          for (const x of d.edges) {
            x.path.removeAttribute("pathLength");
          }
          this.classList.add("flowing");
        },
        last * 140 + 900,
      );
    };
    if (reduced() || !("IntersectionObserver" in window)) {
      show();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) {
          return;
        }
        io.disconnect();
        show();
      },
      { threshold: 0.25 },
    );
    io.observe(this);
  }

  #wire(d: Drawn, layout: FlowLayout) {
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    for (const [id, g] of d.nodes) {
      const n = byId.get(id);
      if (!n) {
        continue;
      }
      g.addEventListener("pointerenter", () => {
        this.#highlight(id);
      });
      g.addEventListener("pointerleave", () => {
        this.#highlight(null);
      });
      g.addEventListener("focus", () => {
        this.#highlight(id);
      });
      g.addEventListener("blur", () => {
        this.#highlight(null);
      });
      const act = () => {
        this.#activate(n);
      };
      g.addEventListener("click", act);
      g.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") {
          return;
        }
        ev.preventDefault();
        act();
      });
    }
  }

  #highlight(id: string | null) {
    const d = this.#drawn;
    if (!d || this.#step >= 0) {
      return;
    }
    d.svg.classList.toggle("focus", id !== null);
    for (const g of d.nodes.values()) {
      g.classList.remove("hot");
    }
    for (const x of d.edges) {
      x.g.classList.remove("hot");
    }
    if (id === null) {
      return;
    }
    d.nodes.get(id)?.classList.add("hot");
    for (const x of d.edges) {
      if (x.e.from !== id && x.e.to !== id) {
        continue;
      }
      x.g.classList.add("hot");
      d.nodes.get(x.e.from)?.classList.add("hot");
      d.nodes.get(x.e.to)?.classList.add("hot");
    }
  }

  #activate(n: PlacedNode) {
    if (n.link) {
      if (n.link.startsWith("#")) {
        location.hash = n.link;
      } else {
        window.open(n.link, "_blank", "noopener");
      }
      return;
    }
    if (n.note) {
      this.#showNote(n, this.#note?.dataset["id"] === n.id && !this.#note.hidden);
    }
  }

  #showNote(n: FlowNode | undefined, hide = false) {
    const box = must(this.#note, "the note box");
    if (!n?.note || hide) {
      box.hidden = true;
      delete box.dataset["id"];
      return;
    }
    box.dataset["id"] = n.id;
    box.innerHTML = `<b>${esc(plain(n.label))}</b> ${esc(n.note)}`;
    box.hidden = false;
  }

  // ---------------------------------------------------------------- play

  #makeControls(): HTMLElement {
    const c = document.createElement("div");
    c.dataset["part"] = "controls";
    c.innerHTML =
      '<button type="button" data-act="play" class="ghost">▶ Play</button>' +
      '<button type="button" data-act="prev" class="ghost" aria-label="Previous step">‹</button>' +
      '<button type="button" data-act="next" class="ghost" aria-label="Next step">›</button>' +
      '<span class="gw-meta" data-part="count"></span>';
    c.addEventListener("click", (ev) => {
      const act = (ev.target as HTMLElement).closest("button")?.dataset["act"];
      if (act === "play") {
        this.#toggle();
      }
      if (act !== "prev" && act !== "next") {
        return;
      }
      this.#stop();
      const to = this.#step + (act === "next" ? 1 : -1);
      this.#go(Math.max(0, Math.min(this.#order.length - 1, to)));
    });
    this.append(c);
    return c;
  }

  #toggle() {
    if (this.#timer) {
      this.#stop();
      return;
    }
    if (this.#step >= this.#order.length - 1) {
      this.#step = -1;
    }
    this.#playButton("❚❚ Pause");
    const tick = () => {
      this.#go(this.#step + 1);
      if (this.#step < this.#order.length - 1) {
        this.#timer = window.setTimeout(tick, STEP_MS);
      } else {
        this.#stop();
      }
    };
    tick();
  }

  #stop() {
    clearTimeout(this.#timer);
    this.#timer = 0;
    this.#playButton("▶ Play");
  }

  #playButton(label: string) {
    const b = this.#controls?.querySelector<HTMLButtonElement>('[data-act="play"]');
    if (b) {
      b.textContent = label;
    }
  }

  #go(step: number) {
    const d = this.#drawn;
    if (!d) {
      return;
    }
    this.classList.add("drawn");
    this.#step = step;
    const seen = new Set(this.#order.slice(0, step + 1));
    const current = this.#order[step];
    d.svg.classList.add("playing");
    d.svg.classList.remove("focus");
    for (const [id, g] of d.nodes) {
      g.classList.toggle("seen", seen.has(id));
      g.classList.toggle("current", id === current);
    }
    let into: Drawn["edges"][number] | undefined;
    for (const x of d.edges) {
      const on = seen.has(x.e.from) && seen.has(x.e.to);
      x.g.classList.toggle("seen", on);
      if (x.e.to === current && seen.has(x.e.from) && x.e.from !== current) {
        into ??= x;
      }
    }
    if (into) {
      this.#travel(into);
    }
    const count = this.#controls?.querySelector('[data-part="count"]');
    if (count) {
      count.textContent = `${step + 1} / ${this.#order.length}`;
    }
    this.#showNote(this.#graph?.nodes.find((n) => n.id === current));
  }

  /** A dot runs along the edge into the step, so the eye follows the flow. */
  #travel({ path, g }: Drawn["edges"][number]) {
    for (const old of this.querySelectorAll(".runner")) {
      old.remove();
    }
    if (reduced()) {
      return;
    }
    const len = path.getTotalLength();
    const dot = svg("circle", { r: 5, class: "runner" }, g);
    // A hidden tab runs no animation frames; the dot must not outlive its step.
    setTimeout(() => {
      dot.remove();
    }, 900);
    const t0 = performance.now();
    const frame = (t: number) => {
      const k = Math.min(1, (t - t0) / 650);
      const p = path.getPointAtLength(len * (1 - (1 - k) ** 2));
      dot.setAttribute("cx", String(p.x));
      dot.setAttribute("cy", String(p.y));
      if (k < 1) {
        requestAnimationFrame(frame);
      } else {
        dot.remove();
      }
    };
    requestAnimationFrame(frame);
  }
}

/** The key under a chart: a sample of each kind of line, and what it means. */
function legend(g: FlowGraph): HTMLElement {
  const box = document.createElement("div");
  box.dataset["part"] = "legend";
  for (const item of g.legend) {
    const row = document.createElement("span");
    const tone = item.tone ? ` tone-${item.tone}` : "";
    row.className = `key ${item.style}${tone}`;
    const s = svg("svg", { width: 28, height: 8, viewBox: "0 0 28 8", "aria-hidden": "true" }, row);
    svg("line", { x1: 1, y1: 4, x2: 27, y2: 4, class: "line" }, s);
    row.append(item.text);
    box.append(row);
  }
  return box;
}

export function defineFlow(): void {
  if (!customElements.get("gw-flow")) {
    customElements.define("gw-flow", Flow);
  }
}
