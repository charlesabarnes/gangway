import type { Hono } from "hono";
import { z } from "zod";
import { lintMarkdown } from "@gangway/shared/artifact/lint";
import { TemplateError, TemplateInputSchema } from "@gangway/shared/artifact/templates/index";
import {
  cleanSvg,
  compileTheme,
  ThemeCreateSchema,
  ThemePatchSchema,
  type Theme,
} from "@gangway/shared/artifact/theme";
import {
  ARTIFACT_FILE,
  ARTIFACT_KINDS,
  HOUSE_THEME,
  THEME_ID,
  type ArtifactKind,
} from "@gangway/shared/artifact/vocab";
import { VISIBILITY_VALUES } from "@gangway/shared/api";
import { WATERMARK_CHOICES, type Preview } from "@gangway/shared/domain";
import {
  DEFAULT_ICON_COLOR,
  PREVIEW_ICON_COLORS,
  PREVIEW_ICONS,
} from "@gangway/shared/preview-icon";
import type { ArtifactLibrary } from "../../artifacts/library.ts";
import type { AuditSink } from "../../audit/audit.ts";
import { actorId } from "../../auth/actor.ts";
import type { ArtifactTemplatesRepo, ArtifactThemesRepo } from "../../db/repos/artifacts.ts";
import { entitled } from "../../entitlements.ts";
import { conflict, forbidden, notFound, unprocessable } from "../../errors.ts";
import { checkFiles, packFiles } from "../../mcp/pack.ts";
import type { IdempotentDeploys } from "../../previews/idempotent.ts";
import { SETTINGS, type Settings } from "../../settings.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";
import { readJson } from "../problem.ts";

export type ArtifactRouteDeps = {
  library: ArtifactLibrary;
  themes: ArtifactThemesRepo;
  templates: ArtifactTemplatesRepo;
  settings: Settings;
  audit: AuditSink;
  deploys: IdempotentDeploys;
  wire: (p: Preview) => unknown;
};

const READ = ["previews.read", "previews.read_own", "artifacts.manage"] as const;
const TEMPLATE_BYTES = 512 * 1024;
const TEMPLATE_ID = /^(document|deck|canvas)\/[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/;

const TemplateFieldsSchema = z.strictObject({
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(300).optional(),
  themeId: z.string().regex(THEME_ID).nullable().optional(),
  files: z.record(z.string().min(1).max(255), z.string()),
});
const TemplateCreateSchema = TemplateFieldsSchema.extend({
  id: z.string().regex(TEMPLATE_ID, "an id is <kind>/<slug>, e.g. document/team-update"),
});
const TemplatePatchSchema = TemplateFieldsSchema.partial();

const ArtifactDeploySchema = TemplateInputSchema.extend({
  name: z.string().min(1).max(40).optional(),
  visibility: z.enum(VISIBILITY_VALUES).optional(),
  ttl: z.string().max(16).nullable().optional(),
  icon: z.enum(PREVIEW_ICONS).optional(),
  iconColor: z.enum(PREVIEW_ICON_COLORS).optional(),
  watermark: z.enum(WATERMARK_CHOICES).optional(),
});

const LOGO_URL = (id: string) => `/v1/artifact-themes/${id}/logo.svg`;

function manage(): void {
  if (!entitled("artifact-customisation"))
    throw forbidden("themes and templates of your own are not part of this plan");
}

function logoOf(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined || raw === null || raw === "") return raw === "" ? null : raw;
  const svg = cleanSvg(raw);
  if (!svg) throw unprocessable("logo: an SVG document, <svg …>…</svg>");
  return svg;
}

const themeView = (t: Theme, def: string) => ({ ...t, isDefault: t.id === def });

function themeRoutes(api: Hono<AppEnv>, d: ArtifactRouteDeps): void {
  const { library } = d;
  api.get("/artifact-themes", requirePermission(...READ), (c) => {
    const def = library.defaultThemeId();
    return c.json({ themes: library.themes().map((t) => themeView(t, def)), defaultTheme: def });
  });

  api.get("/artifact-themes/:id/theme.css", requirePermission(...READ), (c) => {
    const t = library.theme(c.req.param("id"));
    if (!t) throw notFound(`no such theme: ${c.req.param("id")}`);
    c.header("content-type", "text/css; charset=utf-8");
    return c.body(compileTheme(t, LOGO_URL(t.id)));
  });

  api.get("/artifact-themes/:id/logo.svg", requirePermission(...READ), (c) => {
    const logo = library.theme(c.req.param("id"))?.logo;
    const svg = logo ? cleanSvg(logo) : null;
    if (!svg) throw notFound("this theme has no logo");
    c.header("content-type", "image/svg+xml");
    c.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return c.body(svg);
  });

  api.post("/artifact-themes", requirePermission("artifacts.manage"), async (c) => {
    manage();
    const req = ThemeCreateSchema.parse(await readJson(c));
    if (library.theme(req.id)) throw conflict(`theme "${req.id}" already exists`, { id: req.id });
    const logo = logoOf(req.logo);
    const t = d.themes.create(
      req.id,
      { ...req, ...(logo === undefined ? {} : { logo }) },
      actorId(c.get("actor")),
    );
    d.audit.record(c.get("actor"), "artifact_theme.created", t.id, { old: null, new: t.name });
    return c.json({ theme: themeView(t, library.defaultThemeId()) }, 201);
  });

  api.put("/artifact-themes/default", requirePermission("artifacts.manage"), async (c) => {
    const { id } = z.strictObject({ id: z.string() }).parse(await readJson(c));
    if (!library.theme(id)) throw unprocessable(`no theme called "${id}"`);
    const old = library.defaultThemeId();
    d.settings.set(SETTINGS.artifactTheme, id);
    d.audit.record(c.get("actor"), "settings.changed", SETTINGS.artifactTheme.key, {
      old,
      new: id,
    });
    return c.json({ defaultTheme: id });
  });

  api.put("/artifact-themes/:id", requirePermission("artifacts.manage"), async (c) => {
    manage();
    const id = c.req.param("id");
    if (id === HOUSE_THEME) throw conflict("gangway's own theme cannot be changed; duplicate it");
    const before = d.themes.get(id);
    if (!before) throw notFound(`no such theme: ${id}`);
    const patch = ThemePatchSchema.parse(await readJson(c));
    const logo = logoOf(patch.logo);
    const t = d.themes.update(id, { ...patch, ...(logo === undefined ? {} : { logo }) })!;
    d.audit.record(c.get("actor"), "artifact_theme.updated", id, { old: before.name, new: t.name });
    return c.json({ theme: themeView(t, library.defaultThemeId()) });
  });

  api.delete("/artifact-themes/:id", requirePermission("artifacts.manage"), (c) => {
    const id = c.req.param("id");
    if (id === HOUSE_THEME) throw conflict("gangway's own theme cannot be deleted");
    const before = d.themes.get(id);
    if (!before) throw notFound(`no such theme: ${id}`);
    if (library.defaultThemeId() === id)
      throw conflict(`"${id}" is the default theme; choose another default first`);
    d.themes.delete(id);
    d.audit.record(c.get("actor"), "artifact_theme.deleted", id, { old: before.name, new: null });
    return c.body(null, 204);
  });
}

function checkTemplate(
  d: ArtifactRouteDeps,
  kind: ArtifactKind,
  files: Record<string, string>,
  themeId: string | null | undefined,
): void {
  const { bytes } = checkFiles(files);
  if (bytes > TEMPLATE_BYTES)
    throw unprocessable(`a template holds at most ${TEMPLATE_BYTES / 1024} KiB`);
  const md = files[ARTIFACT_FILE];
  if (md === undefined) throw unprocessable(`a template needs ${ARTIFACT_FILE}`);
  if (themeId && !d.library.theme(themeId)) throw unprocessable(`no theme called "${themeId}"`);
  const r = lintMarkdown(md, { has: (p) => p in files, themes: d.library.themeIds() });
  if (r.issues.length > 0)
    throw unprocessable(
      `${ARTIFACT_FILE}: ${r.issues.map((i) => `line ${i.line}: ${i.message}`).join("; ")}`,
      { issues: r.issues },
    );
  if (r.info && r.info.kind !== kind)
    throw unprocessable(`the id says ${kind} but ${ARTIFACT_FILE} says kind: ${r.info.kind}`);
}

function templateRoutes(api: Hono<AppEnv>, d: ArtifactRouteDeps): void {
  const { library } = d;
  api.get("/artifact-templates", requirePermission(...READ), (c) => {
    const kind = c.req.query("kind");
    if (kind !== undefined && !(ARTIFACT_KINDS as readonly string[]).includes(kind))
      throw unprocessable(`kind: one of ${ARTIFACT_KINDS.join(", ")}`);
    return c.json({ templates: library.templates(kind as ArtifactKind | undefined) });
  });

  api.post("/artifact-templates/render", requirePermission(...READ), async (c) => {
    const input = TemplateInputSchema.parse(await readJson(c));
    try {
      return c.json({ files: library.render(input) });
    } catch (e) {
      if (e instanceof TemplateError) throw unprocessable(e.message);
      throw e;
    }
  });

  api.get("/artifact-templates/:id{.+}", requirePermission(...READ), (c) => {
    const id = c.req.param("id");
    const t = library.templates().find((x) => x.id === id);
    if (!t) throw notFound(`no such template: ${id}`);
    const files = t.builtin ? library.render({ template: id }) : library.custom(id)!.files;
    return c.json({ template: t, files });
  });

  api.post("/artifact-templates", requirePermission("artifacts.manage"), async (c) => {
    manage();
    const req = TemplateCreateSchema.parse(await readJson(c));
    if (library.isBuiltin(req.id) || library.custom(req.id))
      throw conflict(`template "${req.id}" already exists`, { id: req.id });
    const kind = req.id.split("/")[0] as ArtifactKind;
    checkTemplate(d, kind, req.files, req.themeId);
    const t = d.templates.create({ ...req, kind }, actorId(c.get("actor")));
    d.audit.record(c.get("actor"), "artifact_template.created", t.id, { old: null, new: t.name });
    return c.json(
      { template: library.templates().find((x) => x.id === t.id), files: t.files },
      201,
    );
  });

  api.put("/artifact-templates/:id{.+}", requirePermission("artifacts.manage"), async (c) => {
    manage();
    const id = c.req.param("id");
    if (library.isBuiltin(id))
      throw conflict("a built-in template cannot be changed; duplicate it");
    const before = library.custom(id);
    if (!before) throw notFound(`no such template: ${id}`);
    const patch = TemplatePatchSchema.parse(await readJson(c));
    checkTemplate(d, before.kind, patch.files ?? before.files, patch.themeId ?? before.themeId);
    const t = d.templates.update(id, patch)!;
    d.audit.record(c.get("actor"), "artifact_template.updated", id, {
      old: before.name,
      new: t.name,
    });
    return c.json({ template: library.templates().find((x) => x.id === id), files: t.files });
  });

  api.delete("/artifact-templates/:id{.+}", requirePermission("artifacts.manage"), (c) => {
    const id = c.req.param("id");
    if (library.isBuiltin(id)) throw conflict("a built-in template cannot be deleted");
    const before = library.custom(id);
    if (!before) throw notFound(`no such template: ${id}`);
    d.templates.delete(id);
    d.audit.record(c.get("actor"), "artifact_template.deleted", id, {
      old: before.name,
      new: null,
    });
    return c.body(null, 204);
  });
}

/** Deploys an artifact from a template, as the MCP deploy tool's artifact argument does. */
function deployRoute(api: Hono<AppEnv>, d: ArtifactRouteDeps): void {
  api.post(
    "/artifacts",
    requirePermission("previews.deploy", "previews.deploy_static"),
    async (c) => {
      const { name, visibility, ttl, icon, iconColor, watermark, ...input } =
        ArtifactDeploySchema.parse(await readJson(c));
      let files: Record<string, string>;
      try {
        files = d.library.render(input);
      } catch (e) {
        if (e instanceof TemplateError) throw unprocessable(e.message);
        throw e;
      }
      const { archive, digest } = await packFiles(files);
      const res = await d.deploys.deploy(
        {
          actor: c.get("actor"),
          source: { kind: "tarball", archive, digest, runtime: "auto" },
          title: input.title?.slice(0, 100),
          ...(name ? { name } : {}),
          ...(visibility ? { visibility } : {}),
          ...(ttl === undefined ? {} : { ttl }),
          ...(icon ? { icon: { name: icon, color: iconColor ?? DEFAULT_ICON_COLOR } } : {}),
          ...(watermark ? { watermark } : {}),
        },
        c.req.header("idempotency-key"),
      );
      c.header("location", `/v1/previews/${res.preview.id}`);
      return c.json({ preview: d.wire(res.preview) }, 202);
    },
  );
}

export function artifactRoutes(api: Hono<AppEnv>, d: ArtifactRouteDeps): void {
  themeRoutes(api, d);
  templateRoutes(api, d);
  deployRoute(api, d);
}
