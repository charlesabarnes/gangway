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
      theme: "dark",
      accent: "teal",
    })["artifact.md"]!;
    expect(md).toStartWith(
      "---\nkind: deck\ntitle: Q4 plan\nsubtitle: For the board\naccent: teal\ntheme: dark\n",
    );
    expect(lintMarkdown(md).info).toMatchObject({
      kind: "deck",
      title: "Q4 plan",
      accent: "teal",
      theme: "dark",
    });
  });

  test("numbers are clamped, bad choices and unknown options are refused", () => {
    const deck = (options: Record<string, number | string | boolean>) =>
      renderTemplate({ template: "deck/status", options })["artifact.md"]!;
    expect(deck({ streams: 99 })).toBe(deck({ streams: 5 }));
    expect(() => deck({ chart: "pie" })).toThrow(TemplateError);
    expect(() => deck({ colour: 1 })).toThrow("deck/status has no option colour");
    expect(() => renderTemplate({ template: "nope" })).toThrow('no template "nope"');
  });
});

describe("lintMarkdown", () => {
  test("front matter is required and checked", () => {
    expect(issues("# hi")[0]).toContain("start with front matter");
    expect(issues(doc("", "kind: poster\ntitle: T"))).toEqual([
      "1: front matter needs kind: document | dashboard | deck | prototype",
    ]);
    expect(issues(doc("", "kind: document\ntitle: T\nfooter: x\naccent: pink"))).toEqual([
      "1: a document has no footer; it takes kind, title, subtitle, accent, theme, label, byline, date",
      '1: accent="pink": one of flag | red | teal | blue | green',
    ]);
  });

  test("an unknown or unclosed block is named with its line", () => {
    expect(issues(doc("::: carousel\nx\n:::"))).toEqual([
      "5: unknown block :::carousel; blocks are callout | grid | card | section | columns | facts | stats",
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

  test("prototype links must reach a screen", () => {
    const src = `---\nkind: prototype\ntitle: T\nstart: home\n---\n{#home title=Home}\n[Go](#nowhere)\n:button[Next]{go=done}\n\n---\n\n{#done title=Done}\nok\n`;
    expect(issues(src)).toEqual(["7: no screen has the id #nowhere"]);
  });

  test("an unknown inline directive is refused", () => {
    expect(issues(doc(":badge[x]{tone=ok}"))[0]).toContain("unknown :badge[…]");
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
        '<gw-dashboard title=T><gw-stat label=CSAT value="92" format="percent"></gw-stat><gw-chart type="line" x="day" y="n">\nday,count\n1,2</gw-chart></gw-dashboard>',
      ),
    );
    expect(r.issues.map((i) => i.message)).toEqual([
      '<gw-stat> value="92" with format="percent" is 9200%; write 0.92 or "92%"',
      "<gw-chart>: the CSV header (day, count) has no column n",
    ]);
    expect(r.info).toMatchObject({ kind: "dashboard", title: "T" });
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
    for (const k of ["Documents", "Dashboards", "Decks", "Prototypes"])
      expect(guideMarkdown()).toContain(`## ${k}`);
  });
});

describe("planning an artifact", () => {
  const plan = (files: Record<string, string>) => planApp({ paths: Object.keys(files), files });

  test("artifact.md alone is a rendered static site", () => {
    const p = plan(renderTemplate({ template: "dashboard/kpi", accent: "red" }));
    expect(planError(p)).toBeNull();
    expect(p.runtime).toBe("static");
    expect(p.artifact).toEqual({
      kind: "dashboard",
      title: "Storefront, September",
      description: "Last 30 days against the 30 before",
      theme: "system",
      accent: "red",
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
