import { bounds, connector, type Box } from "@gangway/shared/artifact/canvas";
import { svg } from "./flow-draw.ts";

export const MAP_W = 180;
export const MAP_H = 120;

export type View = { k: number; x: number; y: number };

/** The arrows between frames, each `<gw-link>` drawn from its frame to the one it names. */
export function drawArrows(
  links: SVGSVGElement,
  frames: HTMLElement[],
  boxes: Map<string, Box>,
): void {
  for (const old of links.querySelectorAll("g")) {
    old.remove();
  }
  const world = bounds(boxes.values());
  links.setAttribute("width", String(world.x + world.w + 200));
  links.setAttribute("height", String(world.y + world.h + 200));
  for (const f of frames) {
    for (const l of f.querySelectorAll(":scope > gw-link")) {
      const a = boxes.get(f.id);
      const b = boxes.get(l.getAttribute("to") ?? "");
      if (!a || !b) {
        continue;
      }
      const c = connector(a, b);
      const g = svg("g", { class: "gw-arrow" }, links);
      svg("path", { d: c.d, "marker-end": "url(#gw-canvas-arrow)" }, g);
      const text = l.getAttribute("label");
      if (text) {
        const t = svg("text", { x: c.mid.x, y: c.mid.y }, g);
        t.textContent = text;
        const w = t.getComputedTextLength() || text.length * 7;
        g.insertBefore(
          svg("rect", { x: c.mid.x - w / 2 - 6, y: c.mid.y - 11, width: w + 12, height: 22 }),
          t,
        );
      }
    }
  }
}

/** The minimap: every frame, and the part of the board the viewport shows. */
export function paintMap(
  map: SVGSVGElement,
  boxes: Map<string, Box>,
  { k, x, y }: View,
  port: HTMLElement,
): void {
  const world = bounds(boxes.values());
  if (world.w === 0) {
    return;
  }
  const s = Math.min(MAP_W / world.w, MAP_H / world.h);
  const ox = (MAP_W - world.w * s) / 2 - world.x * s;
  const oy = (MAP_H - world.h * s) / 2 - world.y * s;
  const rects = [...boxes.values()]
    .map(
      (b) =>
        `<rect class="f" x="${ox + b.x * s}" y="${oy + b.y * s}" width="${b.w * s}" height="${b.h * s}"/>`,
    )
    .join("");
  const vw = port.clientWidth / k;
  const vh = port.clientHeight / k;
  map.innerHTML = `${rects}<rect class="v" x="${ox + (-x / k) * s}" y="${oy + (-y / k) * s}" width="${vw * s}" height="${vh * s}"/>`;
}
