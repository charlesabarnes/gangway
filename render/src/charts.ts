const NS = "http://www.w3.org/2000/svg";
const COLORS = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)"];
const color = (i: number) => COLORS[i % COLORS.length]!;

export type Row = Record<string, string | number>;
export type ChartConfig = {
  type: string;
  x: string;
  y: string;
  stacked: boolean;
  format: string;
  height: number | undefined;
  labels: Record<string, string>;
};

export function fmt(v: unknown, format: string): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return typeof v === "string" ? v : "";
  const nf = (o: Intl.NumberFormatOptions) => new Intl.NumberFormat("en-US", o).format(v);
  const big = Math.abs(v) >= 100_000;
  switch (format) {
    case "percent":
      return nf({ style: "percent", maximumFractionDigits: 1 });
    case "currency":
      if (big)
        return nf({
          style: "currency",
          currency: "USD",
          notation: "compact",
          maximumFractionDigits: 1,
        });
      return nf({
        style: "currency",
        currency: "USD",
        maximumFractionDigits: Number.isInteger(v) || Math.abs(v) >= 100 ? 0 : 2,
      });
    case "compact":
      return nf({ notation: "compact", maximumFractionDigits: 1 });
    default:
      return big
        ? nf({ notation: "compact", maximumFractionDigits: 1 })
        : nf({ maximumFractionDigits: 2 });
  }
}

function cell(c: string): string | number {
  const n = Number(c.replace(/[%$]/g, ""));
  if (c === "" || !Number.isFinite(n) || !/^-?\$?[\d.]+%?$/.test(c)) return c;
  return c.endsWith("%") ? n / 100 : n;
}

export function parseCsv(text: string): Row[] {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const head = (lines[0] ?? "").split(",").map((c) => c.trim());
  return lines.slice(1).map((l) => {
    const cells = l.split(",").map((c) => c.trim());
    return Object.fromEntries(head.map((h, i) => [h, cell(cells[i] ?? "")]));
  });
}

function svg<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number>,
  parent?: Element,
) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

export function ticks(max: number, min = 0, count = 5): number[] {
  const step0 = (max - min || 1) / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? mag * 10;
  const out: number[] = [];
  for (
    let v = Math.floor(min / step) * step;
    v <= Math.ceil(max / step) * step + step / 2;
    v += step
  )
    out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

const esc = (s: unknown) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );

function tipper(host: HTMLElement) {
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  host.appendChild(tip);
  return {
    show(x: number, y: number, html: string) {
      tip.hidden = false;
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
      tip.innerHTML = html;
    },
    hide: () => (tip.hidden = true),
  };
}

const num = (v: unknown) => (typeof v === "number" ? v : 0);
const label = (s: string) => s.replace(/^\d{4}-(\d\d)-(\d\d)$/, "$1/$2");

type Frame = {
  el: SVGSVGElement;
  g: SVGGElement;
  width: number;
  left: number;
  right: number;
  y: (v: number) => number;
};

function frame(
  host: HTMLElement,
  height: number,
  rows: Row[],
  ys: string[],
  cfg: ChartConfig,
  endLabel: boolean,
): Frame {
  const width = Math.max(240, host.clientWidth || 600);
  const vals = rows.flatMap((r) =>
    cfg.stacked ? [ys.reduce((t, k) => t + num(r[k]), 0)] : ys.map((k) => num(r[k])),
  );
  const t = ticks(Math.max(...vals, 0), Math.min(...vals, 0));
  const left = Math.max(...t.map((v) => fmt(v, cfg.format).length)) * 7 + 12;
  const right = endLabel ? 56 : 10;
  const lo = t[0]!;
  const hi = t.at(-1)!;
  const y = (v: number) => 8 + (1 - (v - lo) / (hi - lo || 1)) * (height - 34);
  const el = svg("svg", { width, height, role: "img" });
  const g = svg("g", { class: "axis" }, el);
  for (const v of t) {
    svg(
      "line",
      { class: v === 0 ? "base" : "grid", x1: left, x2: width - right, y1: y(v), y2: y(v) },
      g,
    );
    svg("text", { x: left - 8, y: y(v), dy: "0.32em", "text-anchor": "end" }, g).textContent = fmt(
      v,
      cfg.format,
    );
  }
  return { el, g, width, left, right, y };
}

function xLabels(f: Frame, rows: Row[], x: string, px: (i: number) => number, height: number) {
  const every = Math.ceil(rows.length / Math.max(1, Math.floor((f.width - f.left) / 70)));
  rows.forEach((r, i) => {
    if (i % every === 0)
      svg("text", { x: px(i), y: height - 8, "text-anchor": "middle" }, f.g).textContent = label(
        String(r[x]),
      );
  });
}

function bars(host: HTMLElement, rows: Row[], ys: string[], cfg: ChartConfig): Element {
  const height = cfg.height ?? 260;
  const f = frame(host, height, rows, ys, cfg, false);
  const band = (f.width - f.left - f.right) / rows.length;
  const groups = cfg.stacked ? 1 : ys.length;
  const w = Math.max(2, Math.min(24, (band * 0.7) / groups - 2));
  const tip = tipper(host);
  rows.forEach((r, i) => {
    let acc = 0;
    ys.forEach((k, s) => {
      const v = num(r[k]);
      const x0 =
        f.left + band * i + band / 2 - (groups * (w + 2)) / 2 + (cfg.stacked ? 0 : s * (w + 2));
      const top = f.y(cfg.stacked ? acc + v : v);
      const bottom = f.y(cfg.stacked ? acc : 0);
      acc += v;
      const gap = cfg.stacked && s < ys.length - 1 ? 2 : 0;
      const rect = svg(
        "rect",
        {
          class: "mark",
          x: x0,
          y: Math.min(top, bottom),
          width: w,
          height: Math.max(0, Math.abs(bottom - top) - gap),
          rx: 2,
          fill: color(s),
        },
        f.el,
      );
      rect.addEventListener("pointerenter", () =>
        tip.show(
          x0 + w / 2,
          top,
          `${esc(r[cfg.x])} · ${esc(cfg.labels[k] ?? k)} <b>${esc(fmt(v, cfg.format))}</b>`,
        ),
      );
      rect.addEventListener("pointerleave", tip.hide);
    });
  });
  xLabels(f, rows, cfg.x, (i) => f.left + band * i + band / 2, height);
  return f.el;
}

function lines(
  host: HTMLElement,
  rows: Row[],
  ys: string[],
  cfg: ChartConfig,
  filled: boolean,
): Element {
  const height = cfg.height ?? 240;
  const f = frame(host, height, rows, ys, cfg, ys.length === 1);
  const span = f.width - f.left - f.right;
  const px = (i: number) => f.left + (rows.length === 1 ? 0.5 : i / (rows.length - 1)) * span;
  ys.forEach((k, s) => {
    const pts = rows.map((r, i) => [px(i), f.y(num(r[k]))] as const);
    const d = pts.map(([a, b], i) => `${i ? "L" : "M"}${a},${b}`).join("");
    const [lx, ly] = pts.at(-1) ?? [0, 0];
    if (filled)
      svg(
        "path",
        { class: "area", d: `${d}L${lx},${f.y(0)}L${pts[0]?.[0] ?? 0},${f.y(0)}Z`, fill: color(s) },
        f.el,
      );
    svg("path", { class: "line", d, stroke: color(s) }, f.el);
    if (ys.length === 1) {
      svg("circle", { class: "dot", cx: lx, cy: ly, r: 4, fill: color(0) }, f.el);
      svg("text", { class: "end", x: lx + 8, y: ly, dy: "0.32em" }, f.el).textContent = fmt(
        rows.at(-1)?.[k],
        cfg.format,
      );
    }
  });
  xLabels(f, rows, cfg.x, px, height);
  const tip = tipper(host);
  const hit = svg("rect", { x: f.left, y: 0, width: span, height, fill: "transparent" }, f.el);
  hit.addEventListener("pointermove", (e) => {
    const at = (e.clientX - f.el.getBoundingClientRect().left - f.left) / span;
    const i = Math.max(0, Math.min(rows.length - 1, Math.round(at * (rows.length - 1))));
    const r = rows[i]!;
    tip.show(
      px(i),
      20,
      `${esc(r[cfg.x])} ${ys.map((k) => `· ${esc(cfg.labels[k] ?? k)} <b>${esc(fmt(r[k], cfg.format))}</b>`).join(" ")}`,
    );
  });
  hit.addEventListener("pointerleave", tip.hide);
  return f.el;
}

function donut(rows: Row[], y: string, cfg: ChartConfig): Element {
  const size = cfg.height ?? 200;
  const wrap = document.createElement("div");
  wrap.className = "donut";
  const el = svg("svg", {
    width: size,
    height: size,
    viewBox: `${-size / 2} ${-size / 2} ${size} ${size}`,
  });
  const total = rows.reduce((t, r) => t + num(r[y]), 0) || 1;
  const R = size / 2 - 4;
  const r0 = R * 0.62;
  const p = (ang: number, rad: number) => `${Math.cos(ang) * rad},${Math.sin(ang) * rad}`;
  let a = -Math.PI / 2;
  rows.forEach((r, i) => {
    const b = a + (num(r[y]) / total) * Math.PI * 2 - 0.02;
    const large = b - a > Math.PI ? 1 : 0;
    svg(
      "path",
      {
        class: "mark",
        d: `M${p(a, R)}A${R},${R} 0 ${large} 1 ${p(b, R)}L${p(b, r0)}A${r0},${r0} 0 ${large} 0 ${p(a, r0)}Z`,
        fill: color(i),
      },
      el,
    );
    a = b + 0.02;
  });
  svg("text", { class: "total", "text-anchor": "middle", dy: "0.35em" }, el).textContent = fmt(
    total,
    cfg.format,
  );
  const legend = document.createElement("ul");
  legend.className = "legend";
  legend.innerHTML = rows
    .map(
      (r, i) =>
        `<li><span class="key" style="background:${color(i)}"></span>${esc(r[cfg.x])} <b>${esc(fmt(r[y], cfg.format))}</b></li>`,
    )
    .join("");
  wrap.append(el, legend);
  return wrap;
}

export function drawChart(host: HTMLElement, rows: Row[], cfg: ChartConfig): void {
  const ys = cfg.y
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const first = rows[0] ?? {};
  const missing = [cfg.x, ...ys].filter((k) => !(k in first));
  if (!rows.length || missing.length)
    throw new Error(
      `no column ${missing.join(", ")} in the data (it has ${Object.keys(first).join(", ")})`,
    );
  host.textContent = "";
  if (ys.length > 1 && cfg.type !== "donut") {
    const legend = document.createElement("ul");
    legend.className = "legend";
    legend.innerHTML = ys
      .map(
        (k, i) =>
          `<li><span class="key" style="background:${color(i)}"></span>${esc(cfg.labels[k] ?? k)}</li>`,
      )
      .join("");
    host.appendChild(legend);
  }
  const make: Record<string, () => Element> = {
    bar: () => bars(host, rows, ys, cfg),
    line: () => lines(host, rows, ys, cfg, false),
    area: () => lines(host, rows, ys, cfg, true),
    donut: () => donut(rows, ys[0]!, cfg),
  };
  const draw = make[cfg.type];
  if (!draw) throw new Error(`type="${cfg.type}": one of bar, line, area, donut`);
  host.appendChild(draw());
}

export function sparkline(values: number[]): SVGSVGElement {
  const w = 90;
  const h = 28;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pts = values.map(
    (v, i) =>
      [
        (i / (values.length - 1)) * (w - 4) + 2,
        h - 4 - ((v - lo) / (hi - lo || 1)) * (h - 8),
      ] as const,
  );
  const el = svg("svg", { width: w, height: h, class: "spark" });
  svg("path", { d: pts.map(([a, b], i) => `${i ? "L" : "M"}${a},${b}`).join("") }, el);
  const [lx, ly] = pts.at(-1) ?? [0, 0];
  svg("circle", { cx: lx, cy: ly, r: 3 }, el);
  return el;
}
