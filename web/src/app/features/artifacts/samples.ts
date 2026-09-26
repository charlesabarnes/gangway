// Small artifacts that show a theme on every kind of block, for the theme previews.

export const SAMPLE_DOC = `---
kind: document
title: Build times halved
subtitle: What slowed CI down and what we changed
byline: Platform team
date: September 2026
---

::: callout title="In short"
Median build time fell from **14 minutes to 6**, and runner cost by a third.
:::

::: stats
Median build | 6 min | -57% down-good
Builds a day | 412 | +21%
Runner cost | $1,840 | -34% down-good
:::

## Three steps took most of the time

\`\`\`chart bar x=week y=install,tests stacked title="Minutes per build"
week,install,tests
W1,4.4,5.8
W2,4.6,5.8
W3,0.9,5.8
W4,0.9,2.9
\`\`\`

| Change | Saved | Status |
|---|---:|---|
| Cache dependencies | 3.8 min | :flag[Done]{tone=ok} |
| Split tests | 2.9 min | :flag[Rolling out]{tone=flag} |
`;

export const SAMPLE_DECK = `---
kind: deck
title: A preview for every pull request
subtitle: Review the change, not a description of it
footer: Platform team
---

# A preview for every pull request
Review the change, not a description of it

---

## Reviews wait a day, mostly on setup
- Pull the branch, install, run by hand
- Designers cannot do it at all
- So changes are approved **from screenshots**
`;

export const SAMPLE_CANVAS = `---
kind: canvas
title: Checkout flow
layout: row
gap: 120
---

{#cart title="Cart" w=300}
### Your cart
::: facts total
Shoes: £80
Socks: £12
Total: £92
:::
-> pay "Checkout"

---

{#pay title="Pay" w=300}
### Pay
:steps[Cart,Pay,Done]{at=2}

:flag[Card saved]{tone=ok}
-> done "Pay £92"

---

{#done title="Done" frame=note w=300}
Order placed. A receipt is on its way.
`;

export const sampleFiles = (md: string) => ({ 'artifact.md': md });
