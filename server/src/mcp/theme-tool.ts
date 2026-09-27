import {
  HOUSE_TOKENS,
  THEME_FONTS,
  THEME_STYLE,
  TITLE_CASES,
  TITLE_STYLES,
  TITLE_WEIGHTS,
  type Theme,
} from "@gangway/shared/artifact/theme";
import { HOUSE_THEME } from "@gangway/shared/artifact/vocab";
import type { Actor } from "../auth/actor.ts";
import { createTheme, setDefaultTheme, updateTheme, type ThemeDeps } from "../artifacts/themes.ts";
import { notFound, unprocessable } from "../errors.ts";
import type { ToolDeps } from "./tool-deps.ts";
import type { ThemeArgs } from "./setup-tool-specs.ts";

/** Create, change or read a theme; the answer is the theme as stored, for the next edit. */
export function saveTheme(d: ToolDeps, actor: Actor, args: ThemeArgs): string {
  const library = d.ctx.artifacts;
  if (!library || !d.themes) throw notFound("artifact themes are not available on this server");
  const deps: ThemeDeps = { library, audit: d.ctx.audit, ...d.themes };
  const { id, makeDefault, ...fields } = args;
  const changes = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  const existing = library.theme(id);

  let verb: string;
  let theme: Theme;
  if (!existing) {
    if (!args.name) throw unprocessable(`there is no theme "${id}"; a new theme needs a name`);
    theme = createTheme(deps, actor, {
      ...changes,
      id,
      name: args.name,
      tokens: args.tokens ?? { light: {}, dark: {} },
    });
    verb = "created";
  } else if (Object.keys(changes).length > 0) {
    theme = updateTheme(deps, actor, id, changes);
    verb = "updated";
  } else {
    theme = existing;
    verb = "unchanged";
  }
  if (makeDefault) setDefaultTheme(deps, actor, id);

  const isDefault = library.defaultThemeId() === id;
  const lines = [
    `theme ${id} ("${theme.name}") ${verb}${isDefault ? "; it is the server's default" : ""}.`,
    `Use it: deploy artifact: {template, theme: "${id}"}, or theme: ${id} in artifact.md's front matter. Artifacts that name it restyle on their next load.`,
    "",
    JSON.stringify(
      {
        name: theme.name,
        description: theme.description,
        tokens: theme.tokens,
        fonts: theme.fonts,
        style: theme.style,
        logo: theme.logo ? "set" : null,
      },
      null,
      2,
    ),
  ];
  if (id === HOUSE_THEME || verb === "created")
    lines.push(
      "",
      "gangway's own values, for any token left out:",
      JSON.stringify(HOUSE_TOKENS),
      `Fonts: ${Object.entries(THEME_FONTS)
        .map(([k, v]) => `${k}: ${Object.keys(v).join(", ")}`)
        .join(
          "; ",
        )}. titles: ${TITLE_STYLES.join(", ")}; titleWeight: ${TITLE_WEIGHTS.join(", ")}; titleCase: ${TITLE_CASES.join(", ")}.`,
      `Style (the first of each is gangway's own): ${Object.entries(THEME_STYLE)
        .map(([k, v]) => `${k}: ${v.join(", ")}`)
        .join("; ")}.`,
    );
  return lines.join("\n");
}
