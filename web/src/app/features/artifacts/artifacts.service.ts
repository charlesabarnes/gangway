import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { ArtifactKind } from '../../core/artifact.types';
import type {
  ArtifactItem,
  ArtifactTheme,
  TemplateInput,
  TemplateSummary,
  ThemeList,
} from '../../core/artifacts.types';
import type { Preview } from '../../core/api.types';
import { toProblem } from '../../core/problem';

type Files = Record<string, string>;

/** The artifacts API, and the themes list shared by every tab. */
@Injectable({ providedIn: 'root' })
export class ArtifactsService {
  readonly #http = inject(HttpClient);
  readonly themes = signal<ThemeList | null>(null);

  async #call<T>(p: Promise<T>): Promise<T> {
    try {
      return await p;
    } catch (e) {
      throw toProblem(e);
    }
  }

  async loadThemes(): Promise<ThemeList> {
    const list = await this.#call(firstValueFrom(this.#http.get<ThemeList>('/v1/artifact-themes')));
    this.themes.set(list);
    return list;
  }

  theme(id: string | null): ArtifactTheme | undefined {
    const list = this.themes();
    return list?.themes.find((t) => t.id === (id ?? list.defaultTheme));
  }

  list(): Promise<ArtifactItem[]> {
    return this.#call(
      firstValueFrom(this.#http.get<{ artifacts: ArtifactItem[] }>('/v1/artifacts')),
    ).then((r) => r.artifacts);
  }

  templates(kind?: ArtifactKind): Promise<TemplateSummary[]> {
    const q = kind ? `?kind=${kind}` : '';
    return this.#call(
      firstValueFrom(
        this.#http.get<{ templates: TemplateSummary[] }>(`/v1/artifact-templates${q}`),
      ),
    ).then((r) => r.templates);
  }

  template(id: string): Promise<{ template: TemplateSummary; files: Files }> {
    return this.#call(
      firstValueFrom(
        this.#http.get<{ template: TemplateSummary; files: Files }>(`/v1/artifact-templates/${id}`),
      ),
    );
  }

  render(input: TemplateInput): Promise<Files> {
    return this.#call(
      firstValueFrom(this.#http.post<{ files: Files }>('/v1/artifact-templates/render', input)),
    ).then((r) => r.files);
  }

  createTemplate(body: {
    id: string;
    name: string;
    description?: string;
    themeId?: string | null;
    files: Files;
  }): Promise<{ template: TemplateSummary; files: Files }> {
    return this.#call(
      firstValueFrom(
        this.#http.post<{ template: TemplateSummary; files: Files }>(
          '/v1/artifact-templates',
          body,
        ),
      ),
    );
  }

  updateTemplate(
    id: string,
    body: { name?: string; description?: string; themeId?: string | null; files?: Files },
  ): Promise<{ template: TemplateSummary; files: Files }> {
    return this.#call(
      firstValueFrom(
        this.#http.put<{ template: TemplateSummary; files: Files }>(
          `/v1/artifact-templates/${id}`,
          body,
        ),
      ),
    );
  }

  deleteTemplate(id: string): Promise<unknown> {
    return this.#call(firstValueFrom(this.#http.delete(`/v1/artifact-templates/${id}`)));
  }

  async saveTheme(
    id: string,
    body: Pick<ArtifactTheme, 'name' | 'description' | 'tokens' | 'fonts' | 'logo'>,
    create: boolean,
  ): Promise<ArtifactTheme> {
    const req = create
      ? this.#http.post<{ theme: ArtifactTheme }>('/v1/artifact-themes', { id, ...body })
      : this.#http.put<{ theme: ArtifactTheme }>(`/v1/artifact-themes/${id}`, body);
    const { theme } = await this.#call(firstValueFrom(req));
    await this.loadThemes();
    return theme;
  }

  async deleteTheme(id: string): Promise<void> {
    await this.#call(firstValueFrom(this.#http.delete(`/v1/artifact-themes/${id}`)));
    await this.loadThemes();
  }

  async setDefaultTheme(id: string): Promise<void> {
    await this.#call(firstValueFrom(this.#http.put('/v1/artifact-themes/default', { id })));
    await this.loadThemes();
  }

  deploy(
    body: TemplateInput & { name?: string; visibility?: string },
  ): Promise<{ preview: Preview }> {
    return this.#call(firstValueFrom(this.#http.post<{ preview: Preview }>('/v1/artifacts', body)));
  }
}
