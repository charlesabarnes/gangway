import { describe, expect, test } from "bun:test";
import { ARTIFACT_TEMPLATES, renderTemplate } from "@gangway/shared/artifact/index";
import { compile } from "../src/md.ts";

const doc = (body: string, front = "kind: document\ntitle: T") =>
  compile(`---\n${front}\n---\n${body}`);

describe("compile", () => {
  test("front matter becomes the root element's attributes", () => {
    const html = compile("---\nkind: dashboard\ntitle: Ops & more\naccent: teal\n---\nHi");
    expect(html).toStartWith('<gw-dashboard title="Ops &amp; more" accent="teal">');
    expect(html).not.toContain("kind=");
  });

  test("a chart fence becomes a gw-chart holding its csv", () => {
    const html = doc("```chart bar x=month y=a,b\nmonth,a,b\nJan,1,2\n```");
    expect(html).toContain('<gw-chart type="bar" x="month" y="a,b">month,a,b\nJan,1,2</gw-chart>');
  });

  test("a flow fence becomes a gw-flow holding its escaped source", () => {
    const html = doc('```flow title="Path" play\na[Start] --> b{OK?}\n```');
    expect(html).toContain('<gw-flow title="Path" play>a[Start] --&gt; b{OK?}</gw-flow>');
    expect(html).not.toContain("<p><gw-flow");
  });

  test("stats lines become a grid of stats with text deltas", () => {
    const html = doc("::: stats\nChurn | 2.1% | -0.4 pts down-good | vs last month\n:::");
    expect(html).toContain("<gw-grid");
    expect(html).toMatch(/<gw-stat[^>]*label="Churn"[^>]*value="2.1%"/);
    expect(html).toContain('good="down"');
  });

  test("a facts line splits at the colon before a space, so times stay whole", () => {
    const html = doc("::: facts\n14:02: Cache expires\nOwner: Payments\n:::");
    expect(html).toContain("<dt>14:02</dt><dd>Cache expires</dd>");
    expect(html).toContain("<dt>Owner</dt><dd>Payments</dd>");
  });

  test("gw blocks are not wrapped in paragraphs", () => {
    const html = doc("Intro\n\n::stat{label=Users value=12}\n\nOutro");
    expect(html).not.toMatch(/<p>\s*<gw-stat/);
    expect(html).toContain("<p>Intro</p>");
  });

  test("text is escaped inside attributes and prose", () => {
    const html = doc('::: callout title="<b>x</b>"\n<script>1</script> & more\n:::');
    expect(html).toContain('title="&lt;b&gt;x&lt;/b&gt;"');
  });

  test("a deck splits on --- and lays out the first slide as a title", () => {
    const html = compile("---\nkind: deck\ntitle: D\n---\n# One\n\n---\n\n# Two\n\nNotes: say hi");
    const slides = html.match(/<gw-slide[^>]*>/g) ?? [];
    expect(slides).toHaveLength(2);
    expect(slides[0]).toContain('layout="title"');
    expect(html).toContain('<aside class="notes">');
  });

  test("prototype screens keep their ids and link lists become lists", () => {
    const html = compile(
      "---\nkind: prototype\ntitle: P\nstart: home\n---\n{#home}\n- [A](#b)\n- [B](#b)\n\n---\n\n{#b back=home}\n:button[Go]{go=home}",
    );
    expect(html).toContain('<gw-screen id="home">');
    expect(html).toContain('<ul class="list">');
    expect(html).toMatch(/<gw-screen id="b" back="home">/);
  });

  test("a link list puts its flags last and marks the separator after the bold name", () => {
    const html = compile(
      "---\nkind: prototype\ntitle: P\n---\n{#home}\n- [**Lisbon** · 3 to 7 Oct :flag[Soon]{tone=ok}](#home)",
    );
    expect(html).toContain(
      '<span class="gw-row"><strong>Lisbon</strong><span class="gw-sep"> · </span>3 to 7 Oct</span><gw-flag tone="ok">Soon</gw-flag>',
    );
  });

  test("images, steps and tabs become elements, and notes are blocks", () => {
    const html = compile(
      '---\nkind: prototype\ntitle: P\nlook: wireframe\n---\n{#home}\n:image[Room & view]{ratio=4:3}\n\n:steps[Cart,Pay,Done]{at=2}\n\n::: note\nAsk users\n:::\n\n:tabs[Home,Profile]{go="home"}',
    );
    expect(html).toContain('look="wireframe"');
    expect(html).toContain(
      '<gw-image role="img" aria-label="Room &amp; view" style="aspect-ratio:4/3"><span>Room &amp; view</span></gw-image>',
    );
    expect(html).toContain(
      '<gw-steps><span>Cart</span><span aria-current="step">Pay</span><span>Done</span></gw-steps>',
    );
    expect(html).toContain("<gw-note><p>Ask users</p>");
    expect(html).toContain('<gw-tabs><a href="#home">Home</a><a>Profile</a></gw-tabs>');
    expect(html).not.toMatch(/<p>\s*<gw-(image|steps|tabs)/);
  });

  test.each(ARTIFACT_TEMPLATES.map((t) => [t.id]))("template %s compiles", (id) => {
    const md = renderTemplate({ template: id })["artifact.md"]!;
    const html = compile(md);
    expect(html).toMatch(/^<gw-(doc|dashboard|deck|prototype)[ >]/);
    expect(html).not.toContain(":::");
  });
});
