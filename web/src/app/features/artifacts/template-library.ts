import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ArtifactKind } from '../../core/artifact.types';
import { ARTIFACT_KINDS, KIND_LABELS, type TemplateSummary } from '../../core/artifacts.types';
import { AuthService } from '../../core/auth.service';
import type { ProblemError } from '../../core/problem';
import { ArtifactFrame } from './artifact-frame';
import { ArtifactsService } from './artifacts.service';
import { themeCss } from './theme-css';

/** The size each kind is drawn at in a thumbnail: a page's top, a slide, a board. */
export const THUMB: Record<ArtifactKind, { w: number; h: number }> = {
  document: { w: 1100, h: 760 },
  deck: { w: 1280, h: 720 },
  canvas: { w: 1280, h: 800 },
};

/** One template's card: its first page, drawn live, in the theme it would get. */
@Component({
  selector: 'app-template-card',
  imports: [ArtifactFrame, RouterLink],
  template: `
    @let t = template();
    <a
      [routerLink]="['/artifacts/templates', t.id.split('/')[0], t.id.split('/')[1]]"
      class="group flex flex-col gap-3"
      [attr.data-testid]="'template-' + t.id"
    >
      <div class="gw-neatline overflow-hidden p-[5px]">
        @if (files(); as f) {
          <app-artifact-frame
            [files]="f"
            [themeCss]="css()"
            [width]="size().w"
            [height]="size().h"
          />
        } @else {
          <div class="aspect-[16/10] bg-surface"></div>
        }
      </div>
      <div class="flex flex-col gap-1">
        <span class="gw-label"
          >{{ t.builtin ? 'Built in' : 'Made here' }} ·
          <span class="font-mono normal-case">{{ t.id }}</span></span
        >
        <span class="font-serif text-xl leading-tight italic group-hover:underline">{{
          t.name
        }}</span>
        <span class="text-sm leading-snug text-muted">{{ t.description }}</span>
      </div>
    </a>
  `,
})
export class TemplateCard {
  readonly template = input.required<TemplateSummary>();
  readonly #svc = inject(ArtifactsService);
  protected readonly files = signal<Record<string, string> | null>(null);
  protected readonly size = computed(() => THUMB[this.template().kind]);
  protected readonly css = computed(() => {
    const t = this.#svc.theme(this.template().themeId);
    return t ? themeCss(t) : '';
  });

  constructor() {
    queueMicrotask(() =>
      this.#svc.render({ template: this.template().id }).then(
        (f) => this.files.set(f),
        () => this.files.set(null),
      ),
    );
  }
}

/** Every template, built in and made here, grouped by kind: the same list agents get. */
@Component({
  selector: 'app-template-library',
  imports: [RouterLink, TemplateCard],
  template: `
    <div class="flex flex-col gap-10">
      <p class="m-0 max-w-[70ch] text-sm leading-snug text-muted">
        What you see here is what agents see in the catalog. Built-in templates take options;
        duplicate one to change its words, layout or theme for everyone on this server.
      </p>
      @if (error(); as e) {
        <p class="text-sm text-danger" role="alert">{{ e.detail }}</p>
      }
      @for (k of kinds; track k) {
        <section class="flex flex-col gap-5" [attr.data-testid]="'kind-' + k">
          <div class="flex items-end gap-4 border-b border-ink pb-2.5">
            <h2 class="gw-h2">{{ labels[k] }}</h2>
            <span class="font-mono text-sm text-muted">{{ byKind()[k].length }}</span>
            @if (canManage()) {
              <a
                class="gw-action mb-1 ml-auto"
                routerLink="/artifacts/templates/new"
                [queryParams]="{ kind: k }"
                [attr.data-testid]="'new-template-' + k"
                >New {{ labels[k].toLowerCase() }} template</a
              >
            }
          </div>
          <div class="grid gap-7 sm:grid-cols-2 lg:grid-cols-3">
            @for (t of byKind()[k]; track t.id) {
              <app-template-card [template]="t" />
            }
          </div>
        </section>
      }
    </div>
  `,
})
export class TemplateLibrary {
  readonly #svc = inject(ArtifactsService);
  readonly #auth = inject(AuthService);
  protected readonly kinds = ARTIFACT_KINDS;
  protected readonly labels = KIND_LABELS;
  protected readonly canManage = computed(() => this.#auth.can('artifacts.manage'));
  protected readonly templates = signal<TemplateSummary[]>([]);
  protected readonly error = signal<ProblemError | null>(null);
  protected readonly byKind = computed(() => {
    const out = { document: [], deck: [], canvas: [] } as Record<ArtifactKind, TemplateSummary[]>;
    for (const t of this.templates()) out[t.kind]?.push(t);
    return out;
  });

  constructor() {
    if (!this.#svc.themes()) void this.#svc.loadThemes().catch(() => undefined);
    this.#svc.templates().then(
      (t) => this.templates.set(t),
      (e: ProblemError) => this.error.set(e),
    );
  }
}
