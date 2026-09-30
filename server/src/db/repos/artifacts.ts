import { must } from "@gangway/shared/must";
import type { Theme, ThemeFonts, ThemeStyle, ThemeTokens } from "@gangway/shared/artifact/theme";
import type { ArtifactKind } from "@gangway/shared/artifact/vocab";
import type { Db, Params } from "../types.ts";

type ThemeRow = {
  id: string;
  name: string;
  description: string;
  tokens_json: string;
  fonts_json: string;
  style_json: string;
  logo_svg: string | null;
};

const toTheme = (r: ThemeRow): Theme => ({
  id: r.id,
  name: r.name,
  description: r.description,
  builtin: false,
  tokens: JSON.parse(r.tokens_json) as ThemeTokens,
  fonts: JSON.parse(r.fonts_json) as ThemeFonts,
  style: JSON.parse(r.style_json) as ThemeStyle,
  logo: r.logo_svg,
});

export type ThemeWrite = {
  name?: string | undefined;
  description?: string | undefined;
  tokens?: ThemeTokens | undefined;
  fonts?: ThemeFonts | undefined;
  style?: ThemeStyle | undefined;
  logo?: string | null | undefined;
};

export class ArtifactThemesRepo {
  readonly #db: Db;
  readonly #now: () => number;
  // Every artifact page asks for its theme; this answers without the database until a write.
  readonly #byId = new Map<string, Theme | null>();

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  list(): Theme[] {
    return (
      this.#db.query("SELECT * FROM artifact_themes ORDER BY name COLLATE NOCASE") as ThemeRow[]
    ).map(toTheme);
  }

  ids(): string[] {
    return (this.#db.query("SELECT id FROM artifact_themes") as { id: string }[]).map((r) => r.id);
  }

  get(id: string): Theme | undefined {
    const hit = this.#byId.get(id);
    if (hit !== undefined) {
      return hit ?? undefined;
    }
    const r = this.#db.get("SELECT * FROM artifact_themes WHERE id = $id", { id }) as
      ThemeRow | undefined;
    const theme = r ? toTheme(r) : null;
    this.#byId.set(id, theme);
    return theme ?? undefined;
  }

  create(
    id: string,
    t: ThemeWrite & { name: string; tokens: ThemeTokens },
    by: string | null,
  ): Theme {
    const now = this.#now();
    this.#byId.delete(id);
    this.#db.run(
      `INSERT INTO artifact_themes (id, name, description, tokens_json, fonts_json, style_json, logo_svg, created_by, created_at, updated_at)
       VALUES ($id, $name, $description, $tokens, $fonts, $style, $logo, $by, $now, $now)`,
      {
        id,
        name: t.name,
        description: t.description ?? "",
        tokens: JSON.stringify(t.tokens),
        fonts: JSON.stringify(t.fonts ?? {}),
        style: JSON.stringify(t.style ?? {}),
        logo: t.logo ?? null,
        by,
        now,
      },
    );
    return must(this.get(id), "the theme just saved");
  }

  update(id: string, t: ThemeWrite): Theme | undefined {
    const sets: string[] = [];
    const params: Params = { id, now: this.#now() };
    const put = (col: string, key: string, v: string | null) => {
      sets.push(`${col} = $${key}`);
      params[key] = v;
    };
    if (t.name !== undefined) {
      put("name", "name", t.name);
    }
    if (t.description !== undefined) {
      put("description", "description", t.description);
    }
    if (t.tokens !== undefined) {
      put("tokens_json", "tokens", JSON.stringify(t.tokens));
    }
    if (t.fonts !== undefined) {
      put("fonts_json", "fonts", JSON.stringify(t.fonts));
    }
    if (t.style !== undefined) {
      put("style_json", "style", JSON.stringify(t.style));
    }
    if (t.logo !== undefined) {
      put("logo_svg", "logo", t.logo);
    }
    if (sets.length) {
      this.#db.run(
        `UPDATE artifact_themes SET ${sets.join(", ")}, updated_at = $now WHERE id = $id`,
        params,
      );
    }
    this.#byId.delete(id);
    return this.get(id);
  }

  delete(id: string): void {
    this.#db.run("DELETE FROM artifact_themes WHERE id = $id", { id });
    this.#byId.delete(id);
  }
}

/** A template someone made: its files as they will be deployed, before the title is filled in. */
export type StoredTemplate = {
  id: string;
  kind: ArtifactKind;
  name: string;
  description: string;
  themeId: string | null;
  files: Record<string, string>;
  updatedAt: Date;
};

type TemplateRow = {
  id: string;
  kind: string;
  name: string;
  description: string;
  theme_id: string | null;
  files_json: string;
  updated_at: number;
};

const toTemplate = (r: TemplateRow): StoredTemplate => ({
  id: r.id,
  kind: r.kind as ArtifactKind,
  name: r.name,
  description: r.description,
  themeId: r.theme_id,
  files: JSON.parse(r.files_json) as Record<string, string>,
  updatedAt: new Date(r.updated_at),
});

export type TemplateWrite = {
  name?: string | undefined;
  description?: string | undefined;
  themeId?: string | null | undefined;
  files?: Record<string, string> | undefined;
};

export class ArtifactTemplatesRepo {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  list(kind?: ArtifactKind): StoredTemplate[] {
    const where = kind ? "WHERE kind = $kind" : "";
    return (
      this.#db.query(
        `SELECT * FROM artifact_templates ${where} ORDER BY name COLLATE NOCASE`,
        kind ? { kind } : {},
      ) as TemplateRow[]
    ).map(toTemplate);
  }

  /** The list without each template's files, which only a deploy or an edit needs. */
  summaries(
    kind?: ArtifactKind,
  ): Pick<StoredTemplate, "id" | "kind" | "name" | "description" | "themeId">[] {
    const where = kind ? "WHERE kind = $kind" : "";
    return (
      this.#db.query(
        `SELECT id, kind, name, description, theme_id FROM artifact_templates ${where} ORDER BY name COLLATE NOCASE`,
        kind ? { kind } : {},
      ) as Omit<TemplateRow, "files_json" | "updated_at">[]
    ).map((r) => ({
      id: r.id,
      kind: r.kind as ArtifactKind,
      name: r.name,
      description: r.description,
      themeId: r.theme_id,
    }));
  }

  get(id: string): StoredTemplate | undefined {
    const r = this.#db.get("SELECT * FROM artifact_templates WHERE id = $id", { id }) as
      TemplateRow | undefined;
    return r ? toTemplate(r) : undefined;
  }

  create(
    t: TemplateWrite & Pick<StoredTemplate, "id" | "kind" | "name" | "files">,
    by: string | null,
  ): StoredTemplate {
    const now = this.#now();
    this.#db.run(
      `INSERT INTO artifact_templates (id, kind, name, description, theme_id, files_json, created_by, created_at, updated_at)
       VALUES ($id, $kind, $name, $description, $theme, $files, $by, $now, $now)`,
      {
        id: t.id,
        kind: t.kind,
        name: t.name,
        description: t.description ?? "",
        theme: t.themeId ?? null,
        files: JSON.stringify(t.files),
        by,
        now,
      },
    );
    return must(this.get(t.id), "the template just saved");
  }

  update(id: string, t: TemplateWrite): StoredTemplate | undefined {
    const sets: string[] = [];
    const params: Params = { id, now: this.#now() };
    const put = (col: string, key: string, v: string | null) => {
      sets.push(`${col} = $${key}`);
      params[key] = v;
    };
    if (t.name !== undefined) {
      put("name", "name", t.name);
    }
    if (t.description !== undefined) {
      put("description", "description", t.description);
    }
    if (t.themeId !== undefined) {
      put("theme_id", "theme", t.themeId);
    }
    if (t.files !== undefined) {
      put("files_json", "files", JSON.stringify(t.files));
    }
    if (sets.length) {
      this.#db.run(
        `UPDATE artifact_templates SET ${sets.join(", ")}, updated_at = $now WHERE id = $id`,
        params,
      );
    }
    return this.get(id);
  }

  delete(id: string): void {
    this.#db.run("DELETE FROM artifact_templates WHERE id = $id", { id });
  }
}
