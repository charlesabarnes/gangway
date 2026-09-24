# artifact.md

Generated from gangway's guide by `bun scripts/artifact-catalog.ts`; do not edit. The MCP catalog tool returns the same text for one kind, plus its templates and a complete example.

## Front matter (required)
```
---
kind: deck            # document | dashboard | deck | prototype
title: Q3 review
subtitle: One line under the title
accent: flag          # flag (yellow) | red | teal | blue | green
theme: system         # system | light | dark
byline: Platform team # document
date: September 2026  # document
updated: Hourly       # dashboard: shown top right
columns: 4            # dashboard: grid columns
footer: Team · Date   # deck: shown on every slide
device: phone         # prototype: phone | desktop
start: home           # prototype: first screen id
---
```

## Documents
Plain markdown: `##` headings (numbered automatically), paragraphs, lists, tables, `>` quotes, code, plus the blocks and charts below.

## Dashboards
Each block is a cell in the grid: `::stat{}` tiles, charts, `::: card`, `::: callout`, tables inside a card. `::: stats` rows fill the width; a chart takes two cells. Set span=1|2|3|full to change a block's width. Avoid `##` headings; give blocks titles instead.

## Decks
Separate slides with a line that is only `---`. The first slide is the title slide (`# Title` and one line). A slide with only `# Heading` (and one short line) is a section divider. A slide with only `## Title` and one `::stat{}` is a big number. Force a layout with a first line `{layout=section}` (title | section | big). Speaker notes: a line `Notes:` then text, at the end of a slide.

## Prototypes
Separate screens with a line that is only `---`, each starting `{#id title="Screen title" back=previous-id}`. Link to a screen with `[text](#id)`; a list whose items are all links becomes a tappable list. Controls: `:button[Continue]{go=next-id}`, `:button[Back]{go=home ghost}`, `:input[Email]{name=email placeholder="you@example.com"}`, `:select[Plan]{name=plan options="Free,Team"}`, `:toggle[Email me]{name=news on}`. Show a value typed earlier with `{{email}}`.

## Blocks
```
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
```
Values and changes are text, written the way a reader says them: "92%", "$48.2M", "+0.8 pt", "+21". Numbers in `::stat` may use format=number | percent | currency | compact; a percent is a fraction (0.92) or text ("92%").

## Charts
A fenced block named `chart`: the type first, then options, then CSV rows.
````
```chart bar x=month y=volume title="Monthly volume" format=currency
month,volume
Apr,38100000
May,39400000
```
````
Types: bar | line | area | donut. `y` may list several columns (y=new,returning). Options: stacked, format=number | percent | currency | compact, labels="new:New,returning:Returning", caption="…", height=300, span=2 (dashboard), src=data/daily.csv instead of inline rows (deploy the file beside artifact.md). Percent values: 0.94 or 94%.

## Inline
`:flag[On track]{tone=ok}` is a status flag (tone flag | ok | warn | danger).

## Writing
- Titles say the finding ("Volume has climbed every month"), not the topic ("Monthly volume").
- One idea per section or slide; numbers with units; the reader's words, not the data's column names.
- A deck slide holds about 40 words; put the rest in speaker notes.

## When markdown can't say it: the HTML elements
artifact.md compiles to gangway's HTML elements. For a custom layout, write index.html with them instead (no artifact.md):
```html
<!doctype html><html lang="en" data-accent="teal"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>…</title>
<link rel="stylesheet" href="/_gangway/kit.css"><script type="module" src="/_gangway/kit.js"></script></head>
<body><gw-dashboard title="…" columns="4">
  <gw-stat label="CSAT" value="92%" delta="+3 pts"></gw-stat>
  <gw-chart type="line" x="day" y="tickets" span="2">day,tickets
Sep 10,121</gw-chart>
</gw-dashboard></body></html>
```
Elements: gw-doc, gw-dashboard, gw-deck > gw-slide, gw-prototype > gw-screen, gw-section, gw-card, gw-grid, gw-columns, gw-stat, gw-chart, gw-callout, gw-flag, gw-facts (dt/dd pairs). Attributes match the markdown options. Ordinary HTML works inside any of them. Don't put a gw-chart inside a gw-card: both draw a frame.
