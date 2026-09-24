export const ARTIFACT_FILE = "artifact.md";
export const KIT_PATH = "_gangway";

export const ARTIFACT_KINDS = ["document", "dashboard", "deck", "prototype"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export const ARTIFACT_THEMES = ["system", "light", "dark"] as const;
export type ArtifactTheme = (typeof ARTIFACT_THEMES)[number];
export const ARTIFACT_ACCENTS = ["flag", "red", "teal", "blue", "green"] as const;
export type ArtifactAccent = (typeof ARTIFACT_ACCENTS)[number];

export const ROOT_TAG: Record<ArtifactKind, string> = {
  document: "gw-doc",
  dashboard: "gw-dashboard",
  deck: "gw-deck",
  prototype: "gw-prototype",
};

const COMMON_KEYS = ["kind", "title", "subtitle", "accent", "theme", "label"];
export const FRONT_MATTER_KEYS: Record<ArtifactKind, readonly string[]> = {
  document: [...COMMON_KEYS, "byline", "date"],
  dashboard: [...COMMON_KEYS, "updated", "columns"],
  deck: [...COMMON_KEYS, "footer"],
  prototype: [...COMMON_KEYS, "device", "start"],
};

export const CONTAINERS = [
  "callout",
  "grid",
  "card",
  "section",
  "columns",
  "facts",
  "stats",
] as const;
export const CHART_TYPES = ["bar", "line", "area", "donut"] as const;
export const FORMATS = ["number", "percent", "currency", "compact"] as const;
export const TONES = ["flag", "ok", "warn", "danger"] as const;
export const SLIDE_LAYOUTS = ["title", "section", "big"] as const;
export const DEVICES = ["phone", "desktop"] as const;
export const INLINE_DIRECTIVES = ["flag", "button", "input", "select", "toggle"] as const;

export const ELEMENTS = [
  "gw-doc",
  "gw-dashboard",
  "gw-deck",
  "gw-slide",
  "gw-prototype",
  "gw-screen",
  "gw-section",
  "gw-card",
  "gw-grid",
  "gw-columns",
  "gw-stat",
  "gw-chart",
  "gw-callout",
  "gw-flag",
  "gw-facts",
] as const;

export const oneOf = (list: readonly string[]) => list.join(" | ");
