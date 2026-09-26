---
name: create-theme
description: Create or update a gangway artifact theme from a source -- a website, a stylesheet or design-tokens file, a Tailwind config, a brand guide, a logo, or a description -- so the user's documents, decks and canvases come out in their own brand. Maps the source onto gangway's colour tokens for light and dark, its fonts and a logo, saves it with the MCP theme tool, and shows it on a sample artifact. Use when the user asks for a custom theme, their brand's look, or to change an existing theme.
argument-hint: "[URL, file path, or description of the look]"
---

# Make a gangway theme from a source

The source: $ARGUMENTS (if empty or unexpanded, the user's request; if there is still none, ask for a URL, a file or a few words)

A theme is data, not CSS. It has:

- the kit's colour tokens, for light and dark;
- a serif, a sans and a mono font from gangway's short list, and a title style;
- an optional SVG logo.

Every artifact that names the theme (`theme: <id>`) picks it up, and changing the theme restyles those artifacts on their next load, with no redeploy. It cannot reach selectors or layout. For one artifact's one-off look, `css:` in that artifact is the tool, not a theme.

## 1. Read the source

- **A website:** fetch the page (WebFetch, or `curl -sL`), then the stylesheets it links. Look for:
  - CSS custom properties on `:root` and in a dark block (`prefers-color-scheme: dark`, `.dark`, `[data-theme=dark]`);
  - `<meta name="theme-color">`;
  - the background, text, link and button colours;
  - the heading and body `font-family`;
  - an inline `<svg>` logo, or `/logo.svg` or a `.svg` favicon.

  Colours used most on buttons, links and headers are the brand; greys are the ink and rules. If a browser tool is available and the CSS is built or obfuscated, a screenshot settles what the page really looks like.

- **A file:** read it.
  - CSS variables, SCSS, `tailwind.config.*` (`theme.colors`, `extend.colors`), W3C design tokens or Figma variables JSON, Style Dictionary output: take the named values.
  - A brand guide PDF or an image: read the listed hex values. Colours picked by eye from a picture are guesses, so say so.
  - An `.svg` logo: use it as the logo.
- **A description** ("like a newspaper", "calm greens"): choose the colours yourself, and say they are your choice.
- **Changing an existing theme:** call the MCP `theme` tool with just `id` to read what it has now, then change only what the user asked for.

## 2. Map it onto the tokens

Start from gangway's own values; the tool prints them after you create a theme, and `id: "chart"` reads them. Set every token that should differ. A token you leave out keeps gangway's navy-and-ivory value, which can clash with a brand.

| Token                                                   | What it colours                                                       | From the source                                                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `paper`                                                 | the page                                                              | the site's background                                                                              |
| `paper-raised`                                          | panels and cards, a step off the page                                 | a card or surface colour, or `paper` nudged                                                        |
| `ink`                                                   | body text and the rule under titles                                   | the text colour                                                                                    |
| `ink-muted`                                             | captions, labels, secondary text                                      | the secondary text grey                                                                            |
| `rule`                                                  | hairlines, table lines, borders                                       | the border colour                                                                                  |
| `primary` / `on-primary`                                | the brand colour: links, buttons, the first chart series / text on it | the main brand colour / white or near-black, whichever reads                                       |
| `flag` / `on-flag`                                      | the highlight: callouts, what matters / text on it                    | the accent or secondary brand colour                                                               |
| `awake`, `warn`, `danger`                               | good, caution, bad                                                    | the site's success, warning and error colours, or a green, amber and red that sit with the palette |
| `header-bg`, `header-fg`, `header-muted`, `header-rule` | title, section and end slides; dark bands                             | a dark brand colour (a footer or nav bar is a good source), its text, its muted text, a line on it |
| `log-bg`, `log-fg`                                      | code blocks                                                           | the site's code colours, or a near-black and near-white                                            |
| `s1` … `s6`                                             | chart series, in order                                                | `s1` = primary, then the other brand colours, then distinct hues of similar weight                 |

Dark mode:

- If the source has one, map it the same way.
- If not, derive it:
  - `paper` becomes a very dark tint of the brand hue, and `ink` a warm near-white;
  - `primary` and the series are lightened so they read on dark;
  - `header-bg` goes darker than `paper`.

  `oklch()` makes this easy: keep the hue, change the lightness.

Before saving, check contrast:

- `ink` on `paper` at least 7:1, and `ink-muted` on `paper` at least 4.5:1;
- `on-primary` on `primary`, `on-flag` on `flag` and `header-fg` on `header-bg` at least 4.5:1;
- the same pairs in dark.

Compute them rather than eyeballing, e.g. a few lines of `bun -e` with the WCAG formula. Adjust lightness, not hue, until they pass.

Colours are `#hex`, `rgb()`, `hsl()` or `oklch()`. Gradients, `var()` and named colours are refused.

**Fonts.** gangway serves a fixed list, so pick the nearest:

- **serif:** `plex-serif`, `georgia`, `system-serif`
- **sans:** `plex-sans-condensed` (gangway's labels), `inter` (most modern brands), `system-sans`
- **mono:** `plex-mono`, `system-mono`
- **titles:** `italic-serif` (gangway's), `serif`, or `sans` for a brand whose headings are sans

Tell the user which of their fonts you could not match.

**Logo:** SVG only, under 64 KB. Scripts, styles and outside links are stripped, and it is shown as an image beside titles. A PNG-only logo cannot be used: say so.

## 3. Save it

Call the gangway MCP `theme` tool with:

- `id`: short, lowercase, e.g. `acme`;
- `name`, e.g. "Acme";
- `description`: one line on the source, e.g. "From acme.com, September 2026";
- `tokens: {light: {...}, dark: {...}}`, `fonts`, and `logo` if you have one.

`tokens` replaces the theme's whole token set, so send every token each time.

- **"… lacks the artifacts.manage permission":** the connection lacks the `themes` scope. Tell the user to run `/mcp`, re-authenticate gangway, and tick "themes" on the consent page. If they may not have it, a gangway admin can enter the values in the UI (Artifacts › Themes); give them the JSON.
- **"not part of this plan":** custom themes are not available on this server.
- **A refused colour** names the token: fix exactly that.
- Pass `makeDefault: true` only when the user asks for this theme to be the default: it restyles every artifact on the server that names no theme.

## 4. Show it

Deploy one sample with `deploy`:

- `artifact: {template: "document/report", title: "<Name> theme", theme: "<id>"}`;
- `name: "<id>-theme"`, `title`, `icon: "palette"`, `iconColor`, `check: ["/"]`.

A report shows most tokens at once: headline stats, a chart with several series and a table. For a brand that mostly makes slides, add a `deck/pitch` too: its title and section slides show the `header-*` tokens. Artifacts have a light/dark toggle, so one URL shows both modes.

To iterate, call `theme` again with the changed tokens. The sample restyles on reload, so there is no need to redeploy it.

## 5. Hand over

- The theme's id and the sample's URL.
- In a sentence or two: where the colours came from, what you derived (usually dark mode), and which fonts or logo could not be matched.
- How to use it: `theme: <id>` in an artifact's front matter, or `artifact.theme`. Say whether you made it the default.
- Leave the sample running: it expires on its own.
