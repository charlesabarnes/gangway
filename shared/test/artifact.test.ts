import { connector, fit, layoutFrames } from "../src/artifact/canvas.ts";
import { describe, expect, test } from "bun:test";
import { planApp, planError } from "../src/app-plan.ts";
import {
  ARTIFACT_KINDS,
  ARTIFACT_TEMPLATES,
  guideMarkdown,
  guideText,
  lintHtml,
  lintMarkdown,
  pieces,
  renderTemplate,
  scan,
  templatesFor,
  TemplateError,
  type TemplateOption,
} from "../src/artifact/index.ts";

const extremes = (o: TemplateOption): (number | string | boolean)[] =>
  o.kind === "number"
    ? [o.min, o.max]
    : o.kind === "boolean"
      ? [true, false]
      : o.choices.map((c) => c.value);
const lint = (files: Record<string, string>) =>
  lintMarkdown(files["artifact.md"]!, { has: (p) => p in files }).issues.map(
    (i) => `${i.line}: ${i.message}`,
  );
const doc = (body: string, head = "kind: document\ntitle: T") => `---\n${head}\n---\n${body}\n`;
const issues = (src: string) => lintMarkdown(src).issues.map((i) => `${i.line}: ${i.message}`);

describe("templates", () => {
  test.each(ARTIFACT_TEMPLATES.map((t) => t.id))("%s lints clean with its defaults", (id) => {
    expect(lint(renderTemplate({ template: id }))).toEqual([]);
  });

  test.each(ARTIFACT_TEMPLATES.map((t) => t.id))(
    "%s lints clean at every option's extremes",
    (id) => {
      const t = ARTIFACT_TEMPLATES.find((x) => x.id === id)!;
      for (const o of t.options)
        for (const v of extremes(o))
          expect([
            o.key,
            v,
            lint(renderTemplate({ template: id, options: { [o.key]: v } })),
          ]).toEqual([o.key, v, []]);
    },
  );

  test("every kind has at least three templates", () => {
    for (const k of ARTIFACT_KINDS) expect(templatesFor(k).length).toBeGreaterThanOrEqual(3);
  });

  test("title, subtitle, theme and accent land in the front matter", () => {
    const md = renderTemplate({
      template: "deck/pitch",
      title: "Q4 plan",
      subtitle: "For the board",
      mode: "dark",
      theme: "brand",
      accent: "teal",
    })["artifact.md"]!;
    expect(md).toStartWith(
      "---\nkind: deck\ntitle: Q4 plan\nsubtitle: For the board\naccent: teal\nmode: dark\ntheme: brand\n",
    );
    expect(lintMarkdown(md).info).toMatchObject({
      kind: "deck",
      title: "Q4 plan",
      accent: "teal",
      mode: "dark",
      theme: "brand",
    });
  });

  test("theme: light still means the mode, as before there was one", () => {
    const md = renderTemplate({ template: "deck/pitch", theme: "light" })["artifact.md"]!;
    expect(md).toContain("\nmode: light\n");
    expect(lintMarkdown(doc("", "kind: document\ntitle: T\ntheme: dark")).info).toMatchObject({
      mode: "dark",
      theme: null,
    });
  });

  test("a deck's look is its template's own, and checked", () => {
    const look = (template: string) =>
      /\nlook: (\w+)\n/.exec(renderTemplate({ template })["artifact.md"]!)?.[1];
    expect(["deck/pitch", "deck/review", "deck/talk"].map(look)).toEqual([
      "poster",
      "classic",
      "sidebar",
    ]);
    expect(issues(doc("# A", "kind: deck\ntitle: T\nlook: loud"))).toEqual([
      '1: look="loud": one of classic | sidebar | poster',
    ]);
    expect(
      issues(
        doc("# A\n\n---\n\n{layout=steps}\n## B\n1. C", "kind: deck\ntitle: T\nlook: sidebar"),
      ),
    ).toEqual([]);
  });

  test("old template names still work", () => {
    expect(renderTemplate({ template: "document/proposal" })).toEqual(
      renderTemplate({ template: "document/memo" }),
    );
    expect(renderTemplate({ template: "canvas/map" })).toEqual(
      renderTemplate({ template: "canvas/architecture" }),
    );
  });

  test("numbers are clamped, bad choices and unknown options are refused", () => {
    const deck = (options: Record<string, number | string | boolean>) =>
      renderTemplate({ template: "deck/review", options })["artifact.md"]!;
    expect(deck({ streams: 99 })).toBe(deck({ streams: 5 }));
    expect(() => deck({ chart: "pie" })).toThrow(TemplateError);
    expect(() => deck({ colour: 1 })).toThrow("deck/review has no option colour");
    expect(() => renderTemplate({ template: "nope" })).toThrow('no template "nope"');
  });
});

describe("lintMarkdown", () => {
  test("front matter is required and checked", () => {
    expect(issues("# hi")[0]).toContain("start with front matter");
    expect(issues(doc("", "kind: poster\ntitle: T"))).toEqual([
      "1: front matter needs kind: document | deck | canvas",
    ]);
    expect(issues(doc("", "kind: document\ntitle: T\nfooter: x\naccent: pink"))).toEqual([
      "1: a document has no footer; it takes kind, title, subtitle, accent, mode, theme, css, label, byline, date, layout",
      '1: accent="pink": one of flag | red | teal | blue | green',
    ]);
  });

  test("a retired kind is refused with what to use instead", () => {
    expect(issues(doc("", "kind: dashboard\ntitle: T"))).toEqual([
      "1: kind: dashboard is retired; use kind: document; stats and charts work in a document",
    ]);
  });

  test("a theme must be one the server has, and css a file in the upload", () => {
    const src = doc("", "kind: document\ntitle: T\ntheme: brand\ncss: ../x.css");
    expect(
      lintMarkdown(src, { themes: ["acme"], has: () => true }).issues.map((i) => i.message),
    ).toEqual([
      'theme: no theme called "brand"; this server has chart | acme',
      'css: "../x.css" is a path to a .css file in the upload',
    ]);
    const ok = doc("", "kind: document\ntitle: T\ntheme: acme\ncss: style.css");
    expect(lintMarkdown(ok, { themes: ["acme"], has: () => true }).info).toMatchObject({
      theme: "acme",
      css: "style.css",
    });
    expect(lintMarkdown(ok, { has: () => false }).issues.map((i) => i.message)).toEqual([
      "css: style.css is not in the upload",
    ]);
  });

  test("an unknown or unclosed block is named with its line", () => {
    expect(issues(doc("::: carousel\nx\n:::"))).toEqual([
      "5: unknown block :::carousel; blocks are callout | grid | card | section | columns | facts | stats | note | app | side | bar",
    ]);
    expect(issues(doc("::: callout\nx"))).toEqual(["5: :::callout is never closed with :::"]);
  });

  test("a chart's columns must be in its CSV", () => {
    const src = doc("```chart bar x=month y=total\nmonth,amount\nJan,3\n```");
    expect(issues(src)).toEqual(["6: the CSV header (month, amount) has no column total"]);
  });

  test("a chart needs a known type and rows", () => {
    expect(issues(doc("```chart pie x=a y=b\na,b\n1,2\n```"))).toEqual([
      '5: chart type="pie": one of bar | line | area | donut',
    ]);
    expect(issues(doc("```chart bar x=a y=b\n```"))[0]).toContain("the chart has no rows");
  });

  test("a src= file must be in the upload", () => {
    const src = doc("```chart line x=d y=v src=data/x.csv\n```");
    expect(lintMarkdown(src, { has: () => false }).issues[0]!.message).toBe(
      "src=data/x.csv is not in the upload",
    );
  });

  test("a percent written as 92 is refused", () => {
    expect(issues(doc("::stat{label=CSAT value=92 format=percent}"))).toEqual([
      '5: value="92" with format=percent is 9200%; write 0.92 or "92%"',
    ]);
  });

  test("stats and facts lines are checked", () => {
    expect(issues(doc("::: stats\nRevenue\n:::"))).toEqual([
      "6: a stats line is Label | value | change | note",
    ]);
    expect(issues(doc("::: facts\nOwner Payments\nAt 14:02\n:::"))).toEqual([
      "6: a facts line is Name: value",
      "7: a facts line is Name: value",
    ]);
  });

  test("steps and images are checked", () => {
    const src = doc(
      ":steps[Cart,Pay]{at=3}\n:steps[Only]\n:image[Room]{ratio=wide}\n:image[Room]{src=img/room.jpg}",
    );
    expect(
      lintMarkdown(src, { has: () => false }).issues.map((i) => `${i.line}: ${i.message}`),
    ).toEqual([
      "5: :steps[Cart,Pay]{at=3}: at= is the current step, 1 to 2",
      "6: :steps[Only]: list the steps, e.g. :steps[Cart,Pay,Done]",
      "7: :image[Room]{ratio=wide}: ratio= is width:height, e.g. 16:9",
      "8: src=img/room.jpg is not in the upload",
    ]);
  });

  test("a note is a block, and a block that holds blocks takes a longer fence", () => {
    const src = doc(
      ":::: card\n::: facts total\nRoom: £296\nTotal: £340\n:::\n::::\n\n::: note\nTest with five people.\n:::",
    );
    expect(issues(src)).toEqual([]);
  });

  test("screen controls are pieces", () => {
    const src = doc(
      ':button[Pay]{} :button[Back]{ghost}\n:input[Card]{value="4242"}\n:select[Seat]{options="14A,14C"}\n:toggle[Bag]{on}\n:tabs[Best,Cheapest]{at=1}',
    );
    expect(issues(src)).toEqual([]);
  });

  test("an unknown inline directive is refused", () => {
    expect(issues(doc(":badge[x]{tone=ok}"))[0]).toContain("unknown :badge[…]");
  });
});

describe("canvases", () => {
  const canvas = (body: string, fm = "") => `---\nkind: canvas\ntitle: T${fm}\n---\n${body}\n`;

  test("frames need unique ids, whole-number sizes, and x with y", () => {
    expect(
      issues(canvas('{title="No id"}\nx\n\n---\n\n{#a w=wide}\n\n---\n\n{#a x=10}\ny')),
    ).toEqual([
      '5: start each frame with {#id title="…"}',
      "10: w=wide: a whole number of pixels",
      "14: two frames are called #a",
      "14: give x and y together, or neither",
    ]);
  });

  test("an arrow must reach a frame", () => {
    expect(issues(canvas('{#a}\n-> b "go"\n-> nowhere'))).toEqual([
      "6: -> b: no frame has the id #b",
      "7: -> nowhere: no frame has the id #nowhere",
    ]);
    expect(issues(canvas("{#a}\n-> b\n\n---\n\n{#b}\nok"))).toEqual([]);
  });

  test("a frame's style is one the kit draws", () => {
    expect(issues(canvas("{#a frame=window url=app.example.com/pay w=1280 h=800}\nx"))).toEqual([]);
    expect(issues(canvas("{#a frame=bogus}\nx"))[0]).toContain('frame="bogus"');
  });

  test("an app screen's blocks nest", () => {
    const src = canvas(
      "{#a frame=window}\n::::: app\n::: side\nSkyway\n\n- **Search**\n:::\n\n::: bar\n## Pay\n:button[Pay]{}\n:::\n\n:::: columns wide\n::: card\nx\n:::\n\n+++\n\ny\n::::\n:::::",
    );
    expect(issues(src)).toEqual([]);
  });

  test("layout, columns and gap are checked", () => {
    expect(issues(canvas("{#a}\nx", "\nlayout: spiral\ncolumns: three"))).toEqual([
      '1: layout="spiral": one of grid | row | column',
      '1: columns: a whole number, not "three"',
    ]);
  });
});

describe("canvas layout", () => {
  const f = (id: string, w = 100, h = 50, x?: number, y?: number) => ({ id, w, h, x, y });

  test("a grid fills rows of `columns`, each as tall as its tallest frame", () => {
    const b = layoutFrames([f("a"), f("b", 100, 80), f("c")], {
      layout: "grid",
      columns: 2,
      gap: 10,
    });
    expect([...b.values()]).toEqual([
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 110, y: 0, w: 100, h: 80 },
      { x: 0, y: 90, w: 100, h: 50 },
    ]);
  });

  test("placed frames stay put; the rest flow from the top left", () => {
    const b = layoutFrames([f("a", 100, 50, 300, 20), f("b"), f("c")], {
      layout: "row",
      columns: 1,
      gap: 10,
    });
    expect(b.get("a")).toEqual({ x: 300, y: 20, w: 100, h: 50 });
    expect(b.get("b")).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    expect(b.get("c")).toEqual({ x: 110, y: 0, w: 100, h: 50 });
  });

  test("an arrow leaves the side facing its target", () => {
    const right = connector({ x: 0, y: 0, w: 100, h: 50 }, { x: 300, y: 0, w: 100, h: 50 });
    expect(right.d).toStartWith("M100,25 ");
    expect(right.toward).toBe("left");
    const below = connector({ x: 0, y: 0, w: 100, h: 50 }, { x: 0, y: 300, w: 100, h: 50 });
    expect(below.d).toStartWith("M50,50 ");
    expect(below.toward).toBe("top");
  });

  test("fit centres the world and never enlarges past the limit", () => {
    expect(fit({ x: 0, y: 0, w: 100, h: 100 }, { w: 1000, h: 800 }, 0)).toEqual({
      k: 1,
      x: 450,
      y: 350,
    });
    expect(fit({ x: 0, y: 0, w: 2000, h: 1000 }, { w: 1000, h: 800 }, 0).k).toBe(0.5);
  });
});

describe("grammar", () => {
  test("slides split on --- outside code fences, with their head attributes", () => {
    const p = pieces("# One\n\n---\n{layout=big}\n## Two\n```\n---\n```\n", 3);
    expect(p.map((x) => [x.line, x.head])).toEqual([
      [4, null],
      [7, { layout: "big" }],
    ]);
  });

  test("blocks carry 1-based lines", () => {
    const b = scan(["intro", "::: callout", "x", ":::"], 10);
    expect(b.map((x) => [x.type, x.line])).toEqual([
      ["text", 10],
      ["container", 11],
    ]);
  });
});

describe("lintHtml", () => {
  const page = (body: string) =>
    `<html><head><link href="/_gangway/kit.css"></head><body>${body}</body></html>`;

  test("one root and known elements", () => {
    expect(
      lintHtml(page("<gw-doc title=T><gw-carousel></gw-carousel></gw-doc>")).issues.map(
        (i) => i.message,
      ),
    ).toEqual(["unknown element <gw-carousel>"]);
    expect(lintHtml(page("<p>no root</p>")).issues[0]!.message).toContain("one root element");
  });

  test("chart columns and percent stats are checked", () => {
    const r = lintHtml(
      page(
        '<gw-doc title=T><gw-stat label=CSAT value="92" format="percent"></gw-stat><gw-chart type="line" x="day" y="n">\nday,count\n1,2</gw-chart></gw-doc>',
      ),
    );
    expect(r.issues.map((i) => i.message)).toEqual([
      '<gw-stat> value="92" with format="percent" is 9200%; write 0.92 or "92%"',
      "<gw-chart>: the CSV header (day, count) has no column n",
    ]);
    expect(r.info).toMatchObject({ kind: "document", title: "T" });
  });
});

describe("guide", () => {
  test.each([...ARTIFACT_KINDS])("the %s guide covers its kind and the shared blocks", (kind) => {
    const g = guideText(kind);
    expect(g).toContain(`# Writing a gangway ${kind}`);
    expect(g).toContain("```chart bar");
    expect(g).toContain("Titles say the finding");
  });

  test("the full guide has every kind", () => {
    for (const k of ["Documents", "Decks", "The look"])
      expect(guideMarkdown()).toContain(`## ${k}`);
  });
});

describe("planning an artifact", () => {
  const plan = (files: Record<string, string>) => planApp({ paths: Object.keys(files), files });

  test("artifact.md alone is a rendered static site", () => {
    const p = plan(renderTemplate({ template: "document/memo", accent: "red" }));
    expect(planError(p)).toBeNull();
    expect(p.runtime).toBe("static");
    expect(p.artifact).toEqual({
      kind: "document",
      title: "Move reviews onto preview environments",
      description: "A two-month pilot for three teams, starting next sprint",
      mode: "system",
      theme: null,
      accent: "red",
      css: null,
      format: "markdown",
    });
  });

  test("a bad artifact.md refuses the plan and names the line", () => {
    expect(planError(plan({ "artifact.md": doc("::: carousel\n:::") }))).toStartWith(
      "artifact.md: line 5: unknown block :::carousel",
    );
  });

  test("an index.html using the kit is an html artifact", () => {
    const p = plan({ "index.html": '<link href="/_gangway/kit.css"><gw-doc title="Hi"></gw-doc>' });
    expect(p.artifact).toMatchObject({ kind: "document", title: "Hi", format: "html" });
  });

  test("a plain index.html beside artifact.md wins: the site is served as it is", () => {
    const p = plan({
      ...renderTemplate({ template: "deck/pitch" }),
      "index.html": "<h1>mine</h1>",
    });
    expect(p.artifact).toBeNull();
    expect(planError(p)).toBeNull();
  });
});
