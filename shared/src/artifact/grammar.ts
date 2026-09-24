export type Attrs = Record<string, string>;

export function parseAttrs(text = ""): Attrs {
  const out: Attrs = {};
  const re = /([#.])?([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const [, sigil, key = "", dq, sq, bare] = m;
    if (sigil === "#") out["id"] = key;
    else if (sigil === ".") out["class"] = [out["class"], key].filter(Boolean).join(" ");
    else out[key] = dq ?? sq ?? bare ?? "";
  }
  return out;
}

/** A chart fence: the first bare word is the type, e.g. ```chart bar x=month y=total */
export function chartAttrs(rest: string): Attrs {
  const [first = "", ...more] = rest.trim().split(/\s+/);
  if (first && !first.includes("=") && !first.startsWith("#") && !first.startsWith("."))
    return { type: first, ...parseAttrs(more.join(" ")) };
  return parseAttrs(rest);
}

export type FrontMatter = { meta: Record<string, string>; body: string; offset: number };

export function frontMatter(src: string): FrontMatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { meta: {}, body: src, offset: 0 };
  const meta: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*?)\s*$/.exec(line);
    if (kv) meta[kv[1]!] = (kv[2] ?? "").replace(/\s+#.*$/, "").replace(/^(["'])(.*)\1$/, "$2");
  }
  return { meta, body: src.slice(m[0].length), offset: m[0].split("\n").length - 1 };
}

export type Block =
  | {
      type: "container";
      name: string;
      attrs: Attrs;
      line: number;
      closed: boolean;
      body: Block[];
      raw: string[];
    }
  | { type: "chart"; attrs: Attrs; line: number; closed: boolean; csv: string[] }
  | { type: "flow"; attrs: Attrs; line: number; closed: boolean; src: string[] }
  | { type: "stat"; attrs: Attrs; line: number }
  | { type: "code"; line: number; lines: string[] }
  | { type: "text"; line: number; text: string };

const OPEN = /^(:{3,})\s*([\w-]+)\s*(.*)$/;
const FENCE_END = /^```\s*$/;

function fenced(lines: string[], i: number): { end: number; inner: string[]; closed: boolean } {
  const inner: string[] = [];
  let j = i + 1;
  for (; j < lines.length && !FENCE_END.test(lines[j]!); j++) inner.push(lines[j]!);
  return { end: j, inner, closed: j < lines.length };
}

/** Splits markdown into blocks gangway knows and plain text, with 1-based line numbers. */
export function scan(lines: string[], first = 1): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const at = first + i;
    const chart = /^```chart\b(.*)$/.exec(line);
    if (chart) {
      const f = fenced(lines, i);
      out.push({
        type: "chart",
        attrs: chartAttrs(chart[1] ?? ""),
        line: at,
        closed: f.closed,
        csv: f.inner,
      });
      i = f.end;
      continue;
    }
    const flow = /^```(flow|mermaid)\b(.*)$/.exec(line);
    if (flow) {
      const f = fenced(lines, i);
      const head = f.inner.find((l) => l.trim() !== "")?.trim() ?? "";
      // A mermaid fence that is not a flowchart stays a code block.
      if (flow[1] === "flow" || /^(flowchart|graph)\b/i.test(head)) {
        out.push({
          type: "flow",
          attrs: parseAttrs(flow[2] ?? ""),
          line: at,
          closed: f.closed,
          src: f.inner,
        });
        i = f.end;
        continue;
      }
    }
    if (line.startsWith("```")) {
      const f = fenced(lines, i);
      out.push({ type: "code", line: at, lines: [line, ...f.inner, "```"] });
      i = f.end;
      continue;
    }
    const open = OPEN.exec(line);
    if (open) {
      const close = new RegExp(`^:{${open[1]!.length}}\\s*$`);
      const raw: string[] = [];
      let j = i + 1;
      for (; j < lines.length && !close.test(lines[j]!); j++) raw.push(lines[j]!);
      const [name = "", rest = ""] = [open[2], open[3]];
      out.push({
        type: "container",
        name,
        attrs: parseAttrs(rest),
        line: at,
        closed: j < lines.length,
        body: scan(raw, at + 1),
        raw,
      });
      i = j;
      continue;
    }
    const stat = /^::stat\{(.*)\}\s*$/.exec(line);
    if (stat) {
      out.push({ type: "stat", attrs: parseAttrs(stat[1]), line: at });
      continue;
    }
    out.push({ type: "text", line: at, text: line });
  }
  return out;
}

export type Piece = { line: number; head: Attrs | null; lines: string[]; first: number };

/** Slides or screens: split on lines that are only `---`, outside code fences. */
export function pieces(body: string, offset: number): Piece[] {
  const lines = body.split(/\r?\n/);
  const out: Piece[] = [];
  let cur: string[] = [];
  let start = 0;
  let inFence = false;
  const push = (end: number) => {
    let k = 0;
    while (k < cur.length && cur[k]!.trim() === "") k++;
    const head = /^\{(.*)\}\s*$/.exec(cur[k] ?? "");
    const lead = head ? k + 1 : k;
    out.push({
      line: offset + start + k + 1,
      head: head ? parseAttrs(head[1]) : null,
      lines: cur.slice(lead),
      first: offset + start + lead + 1,
    });
    cur = [];
    start = end + 1;
  };
  lines.forEach((l, i) => {
    if (l.startsWith("```")) inFence = !inFence;
    if (!inFence && /^---\s*$/.test(l)) push(i);
    else cur.push(l);
  });
  push(lines.length);
  return out.filter((p) => p.lines.some((l) => l.trim() !== "") || p.head);
}

export const INLINE_RE = /:(\w+)\[([^\]]*)\](?:\{([^}]*)\})?/g;

export function csvHeader(csv: string[]): string[] {
  const first = csv.find((l) => l.trim() !== "");
  return first ? first.split(",").map((c) => c.trim()) : [];
}
