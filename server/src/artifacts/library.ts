import { setFrontMatter } from "@gangway/shared/artifact/grammar";
import {
  ARTIFACT_TEMPLATES,
  optionText,
  renderTemplate,
  templateById,
  TemplateError,
  type TemplateInput,
  type TemplateOption,
} from "@gangway/shared/artifact/templates/index";
import { cleanSvg, compileTheme, HOUSE, type Theme } from "@gangway/shared/artifact/theme";
import { ARTIFACT_FILE, HOUSE_THEME, type ArtifactKind } from "@gangway/shared/artifact/vocab";
import type {
  ArtifactTemplatesRepo,
  ArtifactThemesRepo,
  StoredTemplate,
} from "../db/repos/artifacts.ts";

export type TemplateSummary = {
  id: string;
  kind: ArtifactKind;
  name: string;
  description: string;
  builtin: boolean;
  options: TemplateOption[];
  themeId: string | null;
};

export type LibraryDeps = {
  themes?: ArtifactThemesRepo | undefined;
  templates?: ArtifactTemplatesRepo | undefined;
  /** The theme an artifact gets when it names none. */
  defaultTheme?: (() => string) | undefined;
};

const summary = (t: StoredTemplate): TemplateSummary => ({
  id: t.id,
  kind: t.kind,
  name: t.name,
  description: t.description,
  builtin: false,
  options: [],
  themeId: t.themeId,
});

/** The built-in templates and themes, and the ones people made on this server, as one catalog. */
export class ArtifactLibrary {
  readonly #d: LibraryDeps;

  constructor(d: LibraryDeps = {}) {
    this.#d = d;
  }

  themes(): Theme[] {
    return [HOUSE, ...(this.#d.themes?.list() ?? [])];
  }

  themeIds(): string[] {
    return this.#d.themes?.ids() ?? [];
  }

  theme(id: string): Theme | undefined {
    return id === HOUSE_THEME ? HOUSE : this.#d.themes?.get(id);
  }

  defaultThemeId(): string {
    const id = this.#d.defaultTheme?.() ?? HOUSE_THEME;
    return this.theme(id) ? id : HOUSE_THEME;
  }

  /** The theme an artifact is drawn in: its own, else the default; a deleted one falls back. */
  resolve(id: string | null): Theme {
    return (id ? this.theme(id) : undefined) ?? this.theme(this.defaultThemeId()) ?? HOUSE;
  }

  themeCss(id: string | null, logoUrl: string): string {
    return compileTheme(this.resolve(id), logoUrl);
  }

  themeLogo(id: string | null): string | null {
    const logo = this.resolve(id).logo;
    return logo ? cleanSvg(logo) : null;
  }

  templates(kind?: ArtifactKind): TemplateSummary[] {
    const builtin = ARTIFACT_TEMPLATES.filter((t) => !kind || t.kind === kind).map(
      (t): TemplateSummary => ({
        id: t.id,
        kind: t.kind,
        name: t.name,
        description: t.description,
        builtin: true,
        options: t.options,
        themeId: null,
      }),
    );
    return [...builtin, ...(this.#d.templates?.list(kind) ?? []).map(summary)];
  }

  custom(id: string): StoredTemplate | undefined {
    return this.#d.templates?.get(id);
  }

  isBuiltin(id: string): boolean {
    return templateById(id) !== undefined;
  }

  /** A template's files with the title and the rest filled in. Throws TemplateError. */
  render(input: TemplateInput): Record<string, string> {
    if (templateById(input.template)) return renderTemplate(input);
    const t = this.custom(input.template);
    if (!t)
      throw new TemplateError(
        `no template "${input.template}"; one of ${this.templates()
          .map((x) => x.id)
          .join(", ")}`,
      );
    if (input.options && Object.keys(input.options).length > 0)
      throw new TemplateError(`${t.id} takes no options; change its files instead`);
    const fill = (s: string) =>
      s
        .replaceAll("{{title}}", input.title ?? t.name)
        .replaceAll("{{subtitle}}", input.subtitle ?? "");
    const files = Object.fromEntries(Object.entries(t.files).map(([p, body]) => [p, fill(body)]));
    const md = files[ARTIFACT_FILE];
    if (md !== undefined) {
      const legacyMode =
        input.theme === "light" || input.theme === "dark" || input.theme === "system";
      files[ARTIFACT_FILE] = setFrontMatter(md, {
        title: input.title,
        subtitle: input.subtitle,
        accent: input.accent,
        mode: input.mode ?? (legacyMode ? input.theme : undefined),
        theme: legacyMode ? undefined : (input.theme ?? t.themeId ?? undefined),
      });
    }
    return files;
  }

  /** The catalog's list of templates for one kind, built-in first. */
  templatesText(kind: ArtifactKind): string {
    return this.templates(kind)
      .map(
        (t) =>
          `- ${t.id}${t.builtin ? "" : " (made here)"}: ${t.description || t.name}\n  options: ${t.options.map(optionText).join("; ") || "none"}`,
      )
      .join("\n");
  }

  themesText(): string {
    const def = this.defaultThemeId();
    return this.themes()
      .map(
        (t) =>
          `- ${t.id}${t.id === def ? " (the default)" : ""}: ${t.name}${t.description ? `. ${t.description}` : ""}`,
      )
      .join("\n");
  }
}

/** Built-ins only: for contexts with no database. */
export const BUILTIN_LIBRARY = new ArtifactLibrary();
