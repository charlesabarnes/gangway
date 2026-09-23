import { Component, computed, inject, input } from '@angular/core';
import { ThemeService } from '../core/theme';

/**
 * The gangway mark, from public/logo.svg (navy, for paper) and public/logo-light.svg (ivory,
 * for the header bar and dark mode). `onDark` always takes the ivory one.
 */
@Component({
  selector: 'app-mark',
  host: { class: 'inline-flex shrink-0' },
  template: `<img [src]="src()" alt="" [width]="size()" [height]="size()" />`,
})
export class Mark {
  readonly size = input(27);
  readonly onDark = input(false);
  readonly #theme = inject(ThemeService);
  protected readonly src = computed(() =>
    this.onDark() || this.#theme.dark() ? 'logo-light.svg' : 'logo.svg',
  );
}
