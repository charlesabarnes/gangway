import { Component, computed, inject, input } from '@angular/core';
import { ThemeService } from '../core/theme';

// logo.svg is navy, for paper; logo-light.svg is ivory, for the header bar and dark mode.
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
