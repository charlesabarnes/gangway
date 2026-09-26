import { ARTIFACT_KINDS, type ArtifactKind } from "./vocab.ts";

const FRONT_MATTER = `## Front matter (required)
\`\`\`
---
kind: deck            # document | deck | canvas
title: Q3 review
subtitle: One line under the title
accent: flag          # flag (yellow) | red | teal | blue | green
mode: system          # system | light | dark
theme: chart          # optional: a theme this server has (the catalog lists them); leave it out for the default
css: style.css        # optional: your own stylesheet from the upload, linked last (see "The look")
byline: Platform team # document
date: September 2026  # document
layout: aside         # document: aside (section titles in a column beside the text) | single
footer: Team · Date   # deck: shown on every slide
layout: grid          # canvas: grid | row | column, for frames without x and y
columns: 3            # canvas: frames per row in a grid
gap: 80               # canvas: pixels between frames
---
\`\`\``;

const LOOK = `## The look
gangway draws every artifact in its house style, Chart: ivory paper and navy ink, rules instead of boxes, italic serif titles, condensed caps labels, numbers in mono, flag yellow for what matters. Use it. The blocks below already look right together: reach for a block before any custom markup, and let the theme carry colour and type.

Only when the user asks for something unusual (a brand of their own, a poster, a playful or highly visual piece) step outside it:
1. A theme the server has (\`theme: <id>\`) if one fits.
2. \`css: style.css\` for a few changes on top: the kit's tokens are CSS variables (--paper, --ink, --ink-muted, --rule, --flag, --font-serif, --font-sans, --font-mono), so override them before overriding elements.
3. index.html of your own, with or without the elements below, for a layout the blocks cannot make.
Say in your reply which of these you used and why.`;

const BLOCKS = `## Blocks
\`\`\`
::: callout title="In short" tone=warn     (tone: flag | ok | warn | danger)
Markdown inside.
:::

::: stats                                  (one tile per line: Label | value | change | note)
Revenue | $48.2M | +12% | vs Q2
CSAT | 92% | +3 pts
Backlog | 138 | +21 down-good              ("down-good" after the change: a fall is good, so this rise shows red)
:::

::stat{label="Median wait" value="26 h" delta="-40%" good=down note="since June"}

::: columns                                (two columns; +++ separates them)
Left markdown
+++
Right markdown
:::

::: facts                                  (Name: value, with dotted leaders)
Owner: Payments team
:::

::: card title="Title" eyebrow="Label" span=2
Markdown inside.
:::

::: grid columns=3
Blocks side by side.
:::
\`\`\`
Values and changes are text, written the way a reader says them: "92%", "$48.2M", "+0.8 pt", "+21". Numbers in \`::stat\` may use format=number | percent | currency | compact; a percent is a fraction (0.92) or text ("92%").`;

const CHARTS = `## Charts
A fenced block named \`chart\`: the type first, then options, then CSV rows.
\`\`\`\`
\`\`\`chart bar x=month y=volume title="Monthly volume" format=currency
month,volume
Apr,38100000
May,39400000
\`\`\`
\`\`\`\`
Types: bar | line | area | donut. \`y\` may list several columns (y=new,returning). Options: stacked, format=number | percent | currency | compact, labels="new:New,returning:Returning", caption="…", height=300, src=data/daily.csv instead of inline rows (deploy the file beside artifact.md). Percent values: 0.94 or 94%.`;

const FLOWS = `## Flowcharts
A fenced block named \`flow\` (or \`mermaid\`), in Mermaid's flowchart syntax. gangway lays it out in its own style, draws it in as the reader reaches it, and highlights a step's paths on hover.
\`\`\`\`
\`\`\`flow title="From push to URL" play
flowchart LR
  push([Push]) --> plan{Can it plan?}
  plan -->|no| refuse[Refuse]:::danger
  plan -->|yes| build[Build] --> url([Live])
  build -. retry .-> build
  note plan: Reads the upload and picks a runtime.
  click url "https://example.com"
\`\`\`
\`\`\`\`
Shapes: \`id[box]\`, \`id(rounded)\`, \`id([start/end])\`, \`id((circle))\`, \`id{decision}\`, \`id[(database)]\`. Arrows: \`-->\`, \`-->|label|\` or \`-- label -->\`, \`-.->\` (dotted), \`==>\` (thick), \`---\` (no head), \`<-->\`. Chains work: \`a --> b --> c\`. Tones: \`id:::ok\` or \`class a,b warn\` (flag | ok | warn | danger | muted). \`note id: text\` shows under the chart when the step is clicked. \`click id "https://…"\` makes it a link. Options on the fence: title="…", caption="…", direction=TB|LR|BT|RL, play (a Play button steps through it), animate (edges keep flowing). \`classDef\` and \`style\` are accepted and ignored. Keep a process under about 15 steps; use TB when there are more than 6 in a row, so it fits the page without scrolling.

### Systems and architecture
For what runs where and what talks to what, put boxes in groups and give the paths meaning:
\`\`\`\`
\`\`\`flow title="How a request reaches data" caption="Staging shares the box; only the database is separate."
flowchart LR
  shop[Shopper<br/>storefront]
  subgraph vps [VPS 3.151.78.148]
    nginx[nginx<br/>\`:443, routes by host\`]
    subgraph prod [Production]
      api[admin-backend :3000<br/>\`api.example.com\`]
    end
    subgraph stage [Staging]
      sapi[admin-backend-staging<br/>\`staging-api.example.com\`]
    end
  end
  pg[(Postgres<br/>main branch)]
  shop -->|https| nginx --> api -->|SQL| pg
  nginx -.-> sapi
  class prod ok
  class stage warn
  legend ok: production path
  legend warn dashed: staging path
\`\`\`
\`\`\`\`
\`subgraph id [Title] … end\` draws a labelled box around what is inside it, and nests; a line may start or end at a group's id. \`class id tone\` tones a group, and every line leaving it (else entering it) takes that tone, so paths read by colour. A box's first line is its name; each line after \`<br/>\` is a smaller detail under it, in mono when it is \`in backticks\` (hosts, ports, paths). \`legend tone style: meaning\` adds a key under the chart (style: solid | dashed | thick). Give one line its own tone with an id: \`a e1@--> b\` then \`class e1 danger\`. A chart with groups is laid out with right-angled lines, and one wider than the text column takes the whole section. Keep each box to a name and one or two details; the explanation goes in the caption and the prose around the chart. One chart per question ("how a request reaches data", "what a deploy does"), not one chart for everything.`;

const KINDS: Record<ArtifactKind, string> = {
  document:
    "## Documents\nPlain markdown: paragraphs, lists, tables, `>` quotes, code, plus the blocks and charts below. Each `##` heading starts a numbered section, its title in a column beside the text (`layout: single` puts it above instead). What comes before the first `##` is the lead: a callout and a row of stats read well there. `###` is a subheading inside a section.",
  canvas:
    '## Canvases\nA board of frames the reader pans and zooms, like a design file: screens of a flow, illustrations, a mood board. For a system or architecture diagram, write a document with flow charts that use groups instead (see Flowcharts): it reads better than frames of prose. Separate frames with a line that is only `---`, each starting `{#id title="Frame title"}`. A frame holds markdown, any block, an inline `<svg>` or `:image[…]{src=…}`. Size it with `w=390` (pixels; default 400) and `h=` (default: its content); place it with `x=` and `y=`, or leave them out and the frames flow in a grid (front matter `layout`, `columns`, `gap`). `frame=plain` drops the frame around an illustration; `frame=note` is a sticky note. A line `-> other-id "label"` in a frame draws an arrow to another frame. Readers drag to pan, pinch or ctrl+scroll to zoom, press 0 to fit, and click a frame\'s title to zoom to it; `#id` in the URL opens on that frame.',
  deck: "## Decks\nSeparate slides with a line that is only `---`. The first slide is the title slide (`# Title` and one line). A slide starting `## Title` is a content slide with the title ruled off at the top. Choose a layout with a first line `{layout=…}`:\n- `section`: a navy divider, numbered (`## Name`)\n- `statement`: one sentence set large (`## The sentence.` and an optional line under it)\n- `big`: one number (`::stat{…}`)\n- `quote`: a `>` quote, its last line the attribution (`> — Name, role`)\n- `split`: `## Title` and a `::: columns` block, words beside a chart, list or image\n- `end`: the closing slide (`# Thank you`, a line, a `::: facts` block)\nA slide with only `# Heading` is a section divider, and one with only `## Title` and a `::stat{}` a big number, without saying so. Speaker notes: a line `Notes:` then text, at the end of a slide; press n to show them.",
};

const INLINE =
  "## Inline\n`:flag[On track]{tone=ok}` is a status flag (tone flag | ok | warn | danger). `:image[Alt text]{src=img/a.png ratio=16:9}` is an image, or a labelled placeholder with no src. `:steps[Plan,Build,Ship]{at=2}` shows progress through steps.";

const HTML = `## When markdown can't say it: the HTML elements
artifact.md compiles to gangway's HTML elements. For a custom layout, write index.html with them instead (no artifact.md):
\`\`\`html
<!doctype html><html lang="en" data-accent="teal"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>…</title>
<link rel="stylesheet" href="/_gangway/kit.css"><script type="module" src="/_gangway/kit.js"></script></head>
<body><gw-doc title="…" subtitle="…">
  <gw-grid columns="2"><gw-stat label="CSAT" value="92%" delta="+3 pts"></gw-stat><gw-stat label="Tickets" value="121"></gw-stat></gw-grid>
  <h2>Tickets doubled in September</h2>
  <gw-chart type="line" x="day" y="tickets">day,tickets
Sep 10,121</gw-chart>
</gw-doc></body></html>
\`\`\`
Elements: gw-doc, gw-deck > gw-slide, gw-section, gw-card, gw-grid, gw-columns, gw-stat, gw-chart, gw-flow (the flowchart text inside), gw-callout, gw-flag, gw-facts (dt/dd pairs), gw-image, gw-steps, gw-note. Attributes match the markdown options. Ordinary HTML works inside any of them.`;

const WRITING = `## Writing
- Titles say the finding ("Volume has climbed every month"), not the topic ("Monthly volume").
- One idea per section or slide; numbers with units; the reader's words, not the data's column names.
- A deck slide holds about 40 words; put the rest in speaker notes.`;

export function guideText(kind: ArtifactKind): string {
  return [
    `# Writing a gangway ${kind}`,
    "One file, artifact.md, is the whole artifact. gangway checks it on deploy (a 422 names the line) and draws it in its house style, light and dark.",
    FRONT_MATTER,
    LOOK,
    KINDS[kind],
    BLOCKS,
    CHARTS,
    FLOWS,
    INLINE,
    WRITING,
    HTML,
  ].join("\n\n");
}

export function guideMarkdown(): string {
  return (
    [
      "# artifact.md",
      "Generated from gangway's guide by `bun scripts/artifact-catalog.ts`; do not edit. The MCP catalog tool returns the same text for one kind, plus its templates and a complete example.",
      FRONT_MATTER,
      LOOK,
      ...ARTIFACT_KINDS.map((k) => KINDS[k]),
      BLOCKS,
      CHARTS,
      FLOWS,
      INLINE,
      WRITING,
      HTML,
    ].join("\n\n") + "\n"
  );
}
