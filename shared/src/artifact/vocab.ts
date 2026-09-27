export const ARTIFACT_FILE = "artifact.md";
export const KIT_PATH = "_gangway";

export const ARTIFACT_KINDS = ["document", "deck", "canvas"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
/** Kinds gangway no longer deploys; pages already deployed with them still render (ADR-0033). */
export const RETIRED_KINDS = ["dashboard", "prototype"] as const;
export type RetiredKind = (typeof RETIRED_KINDS)[number];
export const ARTIFACT_MODES = ["system", "light", "dark"] as const;
export type ArtifactMode = (typeof ARTIFACT_MODES)[number];
/** gangway's own look; any other theme is one an admin made. */
export const HOUSE_THEME = "chart";
export const THEME_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const ARTIFACT_ACCENTS = ["flag", "red", "teal", "blue", "green"] as const;
export type ArtifactAccent = (typeof ARTIFACT_ACCENTS)[number];

export const ROOT_TAG: Record<ArtifactKind | RetiredKind, string> = {
  document: "gw-doc",
  deck: "gw-deck",
  canvas: "gw-canvas",
  dashboard: "gw-dashboard",
  prototype: "gw-prototype",
};

const COMMON_KEYS = ["kind", "title", "subtitle", "accent", "mode", "theme", "css", "label"];
export const FRONT_MATTER_KEYS: Record<ArtifactKind, readonly string[]> = {
  document: [...COMMON_KEYS, "byline", "date", "layout"],
  deck: [...COMMON_KEYS, "footer"],
  canvas: [...COMMON_KEYS, "layout", "columns", "gap"],
};
export const DOC_LAYOUTS = ["single", "aside"] as const;

export const CONTAINERS = [
  "callout",
  "grid",
  "card",
  "section",
  "columns",
  "facts",
  "stats",
  "note",
  "app",
  "side",
  "bar",
] as const;
export const CHART_TYPES = ["bar", "line", "area", "donut"] as const;
export const FORMATS = ["number", "percent", "currency", "compact"] as const;
export const TONES = ["flag", "ok", "warn", "danger"] as const;
export const SLIDE_LAYOUTS = [
  "title",
  "section",
  "statement",
  "big",
  "quote",
  "split",
  "end",
] as const;
export const INLINE_DIRECTIVES = [
  "flag",
  "image",
  "steps",
  "tabs",
  "button",
  "input",
  "select",
  "toggle",
] as const;

export const ELEMENTS = [
  "gw-doc",
  "gw-deck",
  "gw-slide",
  "gw-canvas",
  "gw-frame",
  "gw-link",
  "gw-section",
  "gw-card",
  "gw-grid",
  "gw-columns",
  "gw-stat",
  "gw-chart",
  "gw-flow",
  "gw-callout",
  "gw-flag",
  "gw-facts",
  "gw-note",
  "gw-image",
  "gw-steps",
  "gw-tabs",
  "gw-app",
  "gw-side",
  "gw-bar",
] as const;

/** An arrow from the frame it is written in: `-> target "label"`. */
export const ARROW_LINE = /^->\s*([\w-]+)(?:\s+"([^"]*)")?\s*$/;

export const oneOf = (list: readonly string[]) => list.join(" | ");
