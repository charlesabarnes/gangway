import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ArtifactTheme } from '../../core/artifacts.types';
import { AuthService } from '../../core/auth.service';
import { Skeleton } from '../../ui/skeleton';
import { ArtifactFrame } from './artifact-frame';
import { ArtifactsService } from './artifacts.service';
import { SAMPLE_DECK, SAMPLE_DOC, sampleFiles } from './samples';
import { themeCss } from './theme-css';

/** A theme shown the way it reads: the top of a document beside a title slide. */
@Component({
  selector: 'app-theme-card',
  imports: [ArtifactFrame, RouterLink],
  template: `
    @let t = theme();
    <a
      [routerLink]="['/artifacts/themes', t.id]"
      class="group flex flex-col gap-3"
      [attr.data-testid]="'theme-' + t.id"
    >
      <div class="gw-neatline grid grid-cols-2 gap-[5px] p-[5px]">
        <app-artifact-frame
          [files]="doc"
          [themeCss]="css()"
          [width]="1100"
          [height]="900"
          [lazy]="true"
        />
        <app-artifact-frame
          [files]="deck"
          [themeCss]="css()"
          [width]="1280"
          [height]="1047"
          [lazy]="true"
        />
      </div>
      <div class="flex flex-col gap-1">
        <span class="gw-label flex gap-2"
          >{{ t.builtin ? "gangway's own" : 'Made here' }}
          @if (t.isDefault) {
            <span class="text-ink">· the default</span>
          }
        </span>
        <span class="font-serif text-xl leading-tight italic group-hover:underline">{{
          t.name
        }}</span>
        @if (t.description) {
          <span class="text-sm leading-snug text-muted">{{ t.description }}</span>
        }
      </div>
    </a>
  `,
})
export class ThemeCard {
  readonly theme = input.required<ArtifactTheme>();
  protected readonly doc = sampleFiles(SAMPLE_DOC);
  protected readonly deck = sampleFiles(SAMPLE_DECK);
  protected readonly css = computed(() => themeCss(this.theme()));
}

@Component({
  selector: 'app-theme-library',
  imports: [RouterLink, Skeleton, ThemeCard],
  template: `
    <div class="flex flex-col gap-6">
      <div class="flex flex-wrap items-end gap-4">
        <p class="m-0 max-w-[70ch] text-sm leading-snug text-muted">
          A theme sets the colours, type, shape and logo every artifact is drawn with. An artifact uses the
          default unless it names another; editing a theme restyles every artifact that uses it on
          its next load.
        </p>
        @if (canManage()) {
          <a
            class="gw-action ml-auto"
            routerLink="/artifacts/themes/new"
            [queryParams]="{ random: 1 }"
            data-testid="random-theme"
            >Random theme</a
          >
          <a class="gw-action" routerLink="/artifacts/themes/new" data-testid="new-theme"
            >New theme</a
          >
        }
      </div>
      @if (!loaded()) {
        <app-skeleton
          kind="cards"
          [count]="2"
          ratio="2 / 1"
          grid="grid gap-7 md:grid-cols-2"
          label="Loading themes"
        />
      }
      <div class="gw-enter grid gap-7 md:grid-cols-2" data-testid="themes">
        @for (t of themes(); track t.id) {
          <app-theme-card [theme]="t" />
        }
      </div>
    </div>
  `,
})
export class ThemeLibrary {
  readonly #svc = inject(ArtifactsService);
  readonly #auth = inject(AuthService);
  protected readonly canManage = computed(() => this.#auth.can('artifacts.manage'));
  protected readonly themes = computed(() => this.#svc.themes()?.themes ?? []);
  protected readonly loaded = computed(() => this.#svc.themesSettled());

  constructor() {
    void this.#svc.loadThemes().catch(() => undefined);
  }
}
