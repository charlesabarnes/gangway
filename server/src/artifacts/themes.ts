// Making and changing themes, shared by /v1/artifact-themes and the MCP theme tool.
import {
  cleanSvg,
  type Theme,
  type ThemeCreate,
  type ThemePatch,
} from "@gangway/shared/artifact/theme";
import { HOUSE_THEME } from "@gangway/shared/artifact/vocab";
import type { AuditSink } from "../audit/audit.ts";
import { actorId, type Actor } from "../auth/actor.ts";
import type { ArtifactThemesRepo } from "../db/repos/artifacts.ts";
import { entitled } from "../entitlements.ts";
import { conflict, forbidden, notFound, unprocessable } from "../errors.ts";
import { SETTINGS, type Settings } from "../settings.ts";
import type { ArtifactLibrary } from "./library.ts";

export type ThemeDeps = {
  library: ArtifactLibrary;
  themes: ArtifactThemesRepo;
  settings: Settings;
  audit: AuditSink;
};

export function manage(): void {
  if (!entitled("artifact-customisation")) {
    throw forbidden("themes and templates of your own are not part of this plan");
  }
}

function logoOf(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined || raw === null || raw === "") {
    return raw === "" ? null : raw;
  }
  const svg = cleanSvg(raw);
  if (!svg) {
    throw unprocessable("logo: an SVG document, <svg …>…</svg>");
  }
  return svg;
}

export function createTheme(d: ThemeDeps, actor: Actor, req: ThemeCreate): Theme {
  manage();
  if (d.library.theme(req.id)) {
    throw conflict(`theme "${req.id}" already exists`, { id: req.id });
  }
  const logo = logoOf(req.logo);
  const t = d.themes.create(
    req.id,
    { ...req, ...(logo === undefined ? {} : { logo }) },
    actorId(actor),
  );
  d.audit.record(actor, "artifact_theme.created", t.id, { old: null, new: t.name });
  return t;
}

export function updateTheme(d: ThemeDeps, actor: Actor, id: string, patch: ThemePatch): Theme {
  manage();
  if (id === HOUSE_THEME) {
    throw conflict("gangway's own theme cannot be changed; duplicate it");
  }
  const before = d.themes.get(id);
  if (!before) {
    throw notFound(`no such theme: ${id}`);
  }
  const logo = logoOf(patch.logo);
  const t = d.themes.update(id, { ...patch, ...(logo === undefined ? {} : { logo }) })!;
  d.audit.record(actor, "artifact_theme.updated", id, { old: before.name, new: t.name });
  return t;
}

export function setDefaultTheme(d: ThemeDeps, actor: Actor, id: string): void {
  if (!d.library.theme(id)) {
    throw unprocessable(`no theme called "${id}"`);
  }
  const old = d.library.defaultThemeId();
  d.settings.set(SETTINGS.artifactTheme, id);
  d.audit.record(actor, "settings.changed", SETTINGS.artifactTheme.key, { old, new: id });
}
