import { drawChart, fmt, parseCsv, sparkline } from "./charts.ts";
import { applyTheme } from "./chrome.ts";
import { esc } from "./md.ts";

const attr = (e: Element, n: string, d = "") => e.getAttribute(n) ?? d;

/** Upgrades once: moving an element (a deck moving its slides) calls connectedCallback again. */
function once(e: HTMLElement): boolean {
  if (e.dataset["ready"]) return false;
  e.dataset["ready"] = "1";
  return true;
}

export function problem(e: HTMLElement, msg: string): void {
  const p = document.createElement("div");
  p.className = "gw-problem";
  p.textContent = `<${e.localName}>: ${msg}`;
  e.prepend(p);
  console.error(p.textContent);
}

function titleBlock(label: string, meta: string, title: string, subtitle: string): HTMLElement {
  const d = document.createElement("header");
  d.className = "gw-title";
  d.innerHTML =
    `<div class="gw-title-top"><span class="gw-caps">${esc(label)}</span><span class="gw-meta">${esc(meta)}</span></div>` +
    (title ? `<h1>${esc(title)}</h1>` : "") +
    (subtitle ? `<p class="gw-subtitle">${esc(subtitle)}</p>` : "");
  return d;
}

export function rootSettings(e: Element): void {
  const accent = e.getAttribute("accent");
  if (accent) document.documentElement.dataset["accent"] = accent;
  const title = e.getAttribute("title");
  if (title) document.title = title;
  const theme = e.getAttribute("theme");
  if (theme) document.documentElement.dataset["pref"] = theme;
  applyTheme();
}

class Doc extends HTMLElement {
  connectedCallback() {
    if (!once(this)) return;
    rootSettings(this);
    this.classList.add("gw-sheet");
    const meta = [attr(this, "byline"), attr(this, "date")].filter(Boolean).join(" · ");
    this.prepend(
      titleBlock(
        attr(this, "label", "Document"),
        meta,
        attr(this, "title"),
        attr(this, "subtitle"),
      ),
    );
  }
}

class Dashboard extends HTMLElement {
  connectedCallback() {
    if (!once(this)) return;
    rootSettings(this);
    const body = document.createElement("div");
    body.className = "gw-body";
    body.style.setProperty("--cols", attr(this, "columns", "4"));
    body.append(...this.childNodes);
    this.append(
      titleBlock(
        attr(this, "label", "Dashboard"),
        attr(this, "updated"),
        attr(this, "title"),
        attr(this, "subtitle"),
      ),
      body,
    );
  }
}

const head = (e: Element, level: "h2" | "h3") =>
  (e.hasAttribute("eyebrow") ? `<span class="gw-caps">${esc(attr(e, "eyebrow"))}</span>` : "") +
  (e.hasAttribute("title") ? `<${level}>${esc(attr(e, "title"))}</${level}>` : "");

class Section extends HTMLElement {
  connectedCallback() {
    const h = head(this, "h2");
    if (once(this) && h)
      this.insertAdjacentHTML("afterbegin", `<div class="gw-section-head">${h}</div>`);
  }
}

class Card extends HTMLElement {
  connectedCallback() {
    const h = head(this, "h3");
    if (once(this) && h) this.insertAdjacentHTML("afterbegin", h);
  }
}

class Grid extends HTMLElement {
  connectedCallback() {
    this.style.setProperty("--cols", attr(this, "columns", "3"));
  }
}

class Stat extends HTMLElement {
  connectedCallback() {
    if (!once(this)) return;
    const raw = attr(this, "value");
    const n = Number(raw);
    const value = raw !== "" && Number.isFinite(n) ? fmt(n, attr(this, "format")) : raw;
    const delta = attr(this, "delta").trim();
    const up = !/^[-−]/.test(delta);
    const good = up === (attr(this, "good", "up") === "up");
    const foot = [
      delta
        ? `<span data-part="delta" class="${good ? "good" : "bad"}">${up ? "▲" : "▼"} ${esc(delta.replace(/^[+\-−]/, ""))}</span>`
        : "",
      this.hasAttribute("note") ? `<span data-part="note">${esc(attr(this, "note"))}</span>` : "",
    ].join("");
    this.innerHTML =
      `<span data-part="label">${esc(attr(this, "label"))}</span><div data-part="row"><span data-part="value">${esc(value)}</span></div>` +
      (foot ? `<div data-part="foot">${foot}</div>` : "");
    const trend = attr(this, "trend")
      .split(",")
      .filter(Boolean)
      .map(Number)
      .filter(Number.isFinite);
    if (trend.length > 1) this.querySelector('[data-part="row"]')?.appendChild(sparkline(trend));
  }
}

class Callout extends HTMLElement {
  connectedCallback() {
    if (once(this) && this.hasAttribute("title"))
      this.insertAdjacentHTML(
        "afterbegin",
        `<span data-part="title">${esc(attr(this, "title"))}</span>`,
      );
  }
}

class Facts extends HTMLElement {
  connectedCallback() {
    if (!once(this)) return;
    const kids = [...this.children];
    kids.forEach((k, i) => {
      if (k.localName !== "dt") return;
      const row = document.createElement("div");
      const dd = kids[i + 1]?.localName === "dd" ? [kids[i + 1]!] : [];
      row.append(k, ...dd);
      this.appendChild(row);
    });
  }
}

class Chart extends HTMLElement {
  connectedCallback() {
    if (!once(this)) return;
    const csv = this.textContent ?? "";
    this.textContent = "";
    if (this.hasAttribute("title"))
      this.insertAdjacentHTML(
        "beforeend",
        `<span data-part="title" class="gw-caps">${esc(attr(this, "title"))}</span>`,
      );
    const plot = document.createElement("div");
    plot.dataset["part"] = "plot";
    this.appendChild(plot);
    if (this.hasAttribute("caption"))
      this.insertAdjacentHTML(
        "beforeend",
        `<p data-part="caption">${esc(attr(this, "caption"))}</p>`,
      );
    void this.#load(plot, csv);
  }

  async #load(plot: HTMLElement, csv: string) {
    let text = csv;
    try {
      if (this.hasAttribute("src"))
        text = await (await fetch(`/${attr(this, "src").replace(/^\//, "")}`)).text();
    } catch (err) {
      return problem(this, `could not load ${attr(this, "src")}: ${(err as Error).message}`);
    }
    const labels = Object.fromEntries(
      attr(this, "labels")
        .split(",")
        .filter(Boolean)
        .map((p) => p.split(":").map((s) => s.trim())) as [string, string][],
    );
    const cfg = {
      type: attr(this, "type", "bar"),
      x: attr(this, "x"),
      y: attr(this, "y"),
      stacked: this.hasAttribute("stacked"),
      format: attr(this, "format"),
      height: Number(attr(this, "height")) || undefined,
      labels,
    };
    const rows = parseCsv(text);
    let last = 0;
    new ResizeObserver(() => {
      const w = plot.clientWidth;
      if (w <= 0 || Math.abs(w - last) <= 4) return;
      last = w;
      try {
        drawChart(plot, rows, cfg);
      } catch (err) {
        plot.textContent = "";
        problem(this, (err as Error).message);
      }
    }).observe(plot);
  }
}

export function defineElements(): void {
  const defs: [string, CustomElementConstructor][] = [
    ["gw-doc", Doc],
    ["gw-dashboard", Dashboard],
    ["gw-section", Section],
    ["gw-card", Card],
    ["gw-grid", Grid],
    ["gw-stat", Stat],
    ["gw-callout", Callout],
    ["gw-facts", Facts],
    ["gw-chart", Chart],
    ["gw-flag", class extends HTMLElement {}],
    ["gw-columns", class extends HTMLElement {}],
  ];
  for (const [name, cls] of defs) if (!customElements.get(name)) customElements.define(name, cls);
}
