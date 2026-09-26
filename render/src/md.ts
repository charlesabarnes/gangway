import {
  frontMatter,
  INLINE_RE,
  parseAttrs,
  pieces,
  scan,
  type Attrs,
  type Block,
  type Piece,
} from "@gangway/shared/artifact/grammar";
import { ROOT_TAG, type ArtifactKind } from "@gangway/shared/artifact/vocab";
import { marked } from "marked";

export const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

export const attrText = (a: Attrs) =>
  Object.entries(a)
    .map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${esc(v)}"`))
    .join("");

function control(name: string, text: string, a: Attrs): string {
  const label = esc(text);
  const field = esc(a["name"] ?? text);
  switch (name) {
    case "flag":
      return `<gw-flag${attrText(a)}>${label}</gw-flag>`;
    case "button":
      return `<button type="button"${a["go"] ? ` data-go="${esc(a["go"])}"` : ""}${"ghost" in a ? ' class="ghost"' : ""}>${label}</button>`;
    case "input":
      return `<label><span>${label}</span><input name="${field}"${["placeholder", "type", "value"].map((k) => (a[k] ? ` ${k}="${esc(a[k])}"` : "")).join("")}></label>`;
    case "select": {
      const opts = (a["options"] ?? "").split(",").map((o) => `<option>${esc(o.trim())}</option>`);
      return `<label><span>${label}</span><select name="${field}">${opts.join("")}</select></label>`;
    }
    case "toggle":
      return `<label class="gw-toggle-field"><span>${label}</span><input type="checkbox" name="${field}"${"on" in a ? " checked" : ""}></label>`;
    case "image": {
      const [w = "16", h = "9"] = (a["ratio"] ?? "16:9").split(":");
      const inner = a["src"]
        ? `<img src="${esc(a["src"])}" alt="${label}">`
        : `<span>${label}</span>`;
      return `<gw-image role="img" aria-label="${label}" style="aspect-ratio:${esc(w)}/${esc(h)}">${inner}</gw-image>`;
    }
    case "steps": {
      const at = Number(a["at"] ?? 1);
      return `<gw-steps>${items(text)
        .map((t, i) => `<span${i + 1 === at ? ' aria-current="step"' : ""}>${esc(t)}</span>`)
        .join("")}</gw-steps>`;
    }
    case "tabs": {
      const go = items(a["go"] ?? "");
      return `<gw-tabs>${items(text)
        .map((t, i) => (go[i] ? `<a href="#${esc(go[i])}">${esc(t)}</a>` : `<a>${esc(t)}</a>`))
        .join("")}</gw-tabs>`;
    }
    default:
      return text;
  }
}

const items = (list: string) =>
  list
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

/** These read fine with no {…}; the form controls need one, so ordinary text like ":input[x]" stays text. */
const BARE = new Set(["flag", "image", "steps", "tabs"]);

const inline = (line: string) =>
  line.replace(INLINE_RE, (whole, name: string, text: string, raw: string | undefined) =>
    raw === undefined && !BARE.has(name) ? whole : control(name, text, parseAttrs(raw)),
  );

function statTag(cells: string[]): string {
  const [label = "", value = "", change = "", note = ""] = cells.map((c) => c.trim());
  const down = /\s+(down-good|good)$/.test(change);
  const a: Attrs = { label, value };
  if (change) a["delta"] = change.replace(/\s+(down-good|good)$/, "");
  if (down) a["good"] = "down";
  if (note) a["note"] = note;
  return `<gw-stat${attrText(a)}></gw-stat>`;
}

function container(b: Extract<Block, { type: "container" }>): string {
  const rows = b.raw.filter((l) => l.trim() !== "");
  if (b.name === "stats")
    return `<gw-grid columns="${b.attrs["columns"] ?? Math.min(4, rows.length)}">${rows.map((l) => statTag(l.split("|"))).join("")}</gw-grid>`;
  if (b.name === "facts")
    return `<gw-facts${attrText(b.attrs)}>${rows
      .map((l) => l.split(/:\s(.*)/s))
      .map(([k = "", v = ""]) => `<dt>${esc(k.trim())}</dt><dd>${inline(esc(v.trim()))}</dd>`)
      .join("")}</gw-facts>`;
  if (b.name === "columns") {
    const halves: string[][] = [[]];
    for (const l of b.raw) {
      if (l.trim() === "+++") halves.push([]);
      else halves.at(-1)!.push(l);
    }
    return `<gw-columns>${halves.map((h) => `<div>${render(scan(h))}</div>`).join("")}</gw-columns>`;
  }
  return `<gw-${b.name}${attrText(b.attrs)}>${render(b.body)}</gw-${b.name}>`;
}

const BLOCK_TAGS = "grid|chart|flow|callout|stat|facts|card|section|columns|note|image|steps|tabs";
const unwrap = (h: string) =>
  h
    .replace(new RegExp(`<p>(\\s*<gw-(?:${BLOCK_TAGS})\\b)`, "g"), "$1")
    .replace(new RegExp(`(</gw-(?:${BLOCK_TAGS})>\\s*)</p>`, "g"), "$1");

/** Renders scanned blocks: runs of plain markdown go through marked, gangway blocks become elements. */
export function render(blocks: Block[]): string {
  const out: string[] = [];
  let text: string[] = [];
  const flush = () => {
    if (text.length) out.push(unwrap(marked.parse(text.join("\n"), { gfm: true, async: false })));
    text = [];
  };
  for (const b of blocks) {
    if (b.type === "text") text.push(inline(b.text));
    else if (b.type === "code") text.push(...b.lines);
    else {
      flush();
      if (b.type === "chart")
        out.push(`<gw-chart${attrText(b.attrs)}>${esc(b.csv.join("\n"))}</gw-chart>`);
      else if (b.type === "flow")
        out.push(`<gw-flow${attrText(b.attrs)}>${esc(b.src.join("\n"))}</gw-flow>`);
      else if (b.type === "stat") out.push(`<gw-stat${attrText(b.attrs)}></gw-stat>`);
      else out.push(container(b));
    }
  }
  flush();
  return out.join("\n");
}

function split(p: Piece): { body: string[]; notes: string[] } {
  const i = p.lines.findIndex((l) => /^notes:\s*/i.test(l));
  if (i === -1) return { body: p.lines, notes: [] };
  return {
    body: p.lines.slice(0, i),
    notes: [p.lines[i]!.replace(/^notes:\s*/i, ""), ...p.lines.slice(i + 1)],
  };
}

function layoutOf(i: number, body: string[]): string | undefined {
  if (i === 0) return "title";
  const lines = body.map((l) => l.trim()).filter(Boolean);
  if (lines[0]?.startsWith("# ") && lines.length <= 2) return "section";
  const stats = lines.filter((l) => l.startsWith("::stat{"));
  if (
    stats.length === 1 &&
    lines.length <= 2 &&
    lines.every((l) => l.startsWith("::stat{") || l.startsWith("## "))
  )
    return "big";
  return undefined;
}

function slide(p: Piece, i: number): string {
  const { body, notes } = split(p);
  const layout = p.head?.["layout"] ?? layoutOf(i, body);
  const a: Attrs = { ...(p.head ?? {}), ...(layout ? { layout } : {}) };
  const aside = notes.length ? `<aside class="notes">${render(scan(notes))}</aside>` : "";
  return `<gw-slide${attrText(a)}>${render(scan(body))}${aside}</gw-slide>`;
}

/** A row's flags go last, and the " · " after its bold name gets a class so a look can drop it. */
const listRow = (inner: string) => {
  const flags = inner.match(/<gw-flag[^>]*>[\s\S]*?<\/gw-flag>/g) ?? [];
  const text = inner
    .replace(/<gw-flag[^>]*>[\s\S]*?<\/gw-flag>/g, "")
    .trim()
    .replace(/^(<strong>[\s\S]*?<\/strong>)\s*·\s*/, '$1<span class="gw-sep"> · </span>');
  return `<span class="gw-row">${text}</span>${flags.join("")}`;
};

const listLinks = (html: string) =>
  html.replace(
    /<ul>((?:\s*<li><a [^>]*>[\s\S]*?<\/a>\s*<\/li>)+\s*)<\/ul>/g,
    (_, items: string) => {
      const rows = items.replace(
        /(<a [^>]*>)([\s\S]*?)(<\/a>)/g,
        (_m, open: string, inner: string, close: string) => `${open}${listRow(inner)}${close}`,
      );
      return `<ul class="list">${rows}</ul>`;
    },
  );

export function compile(src: string): string {
  const { meta, body, offset } = frontMatter(src);
  const kind = (meta["kind"] ?? "document") as ArtifactKind;
  const tag = ROOT_TAG[kind] ?? "gw-doc";
  const { kind: _kind, ...attrs } = meta;
  let inner: string;
  if (kind === "deck") inner = pieces(body, offset).map(slide).join("\n");
  else if (kind === "prototype")
    inner = pieces(body, offset)
      .map(
        (p) =>
          `<gw-screen${attrText(p.head ?? {})}>${listLinks(render(scan(p.lines)))}</gw-screen>`,
      )
      .join("\n");
  else inner = render(scan(body.split(/\r?\n/)));
  return `<${tag}${attrText(attrs)}>${inner}</${tag}>`;
}
