import { Component, inject } from '@angular/core';
import { THEME_CHOICES, ThemeService, type ThemeChoice } from '../core/theme';

const LABEL: Record<ThemeChoice, string> = {
  system: 'Match the system',
  light: 'Light',
  dark: 'Dark',
};

/** System / light / dark, as three icon buttons in the current text colour. */
@Component({
  selector: 'app-theme-toggle',
  host: { class: 'inline-flex' },
  template: `
    <div
      role="group"
      aria-label="Theme"
      class="inline-flex shadow-[inset_0_0_0_1px_color-mix(in_oklch,currentColor_35%,transparent)]"
      data-testid="theme"
    >
      @for (c of choices; track c) {
        <button
          type="button"
          class="flex size-7 items-center justify-center opacity-60 transition hover:opacity-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-flag"
          [class]="theme.choice() === c ? 'bg-current/15 !opacity-100' : ''"
          [attr.aria-pressed]="theme.choice() === c"
          [attr.aria-label]="label[c]"
          [title]="label[c]"
          (click)="theme.set(c)"
          [attr.data-testid]="'theme-' + c"
        >
          <svg
            viewBox="0 0 16 16"
            class="size-3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            aria-hidden="true"
          >
            @switch (c) {
              @case ('system') {
                <rect x="1.5" y="2.5" width="13" height="8.5" />
                <path d="M5.5 13.5h5M8 11v2.5" />
              }
              @case ('light') {
                <circle cx="8" cy="8" r="3" />
                <path
                  d="M8 1v1.8M8 13.2V15M1 8h1.8M13.2 8H15M3 3l1.3 1.3M11.7 11.7 13 13M13 3l-1.3 1.3M4.3 11.7 3 13"
                />
              }
              @case ('dark') {
                <path d="M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7Z" />
              }
            }
          </svg>
        </button>
      }
    </div>
  `,
})
export class ThemeToggle {
  protected readonly theme = inject(ThemeService);
  protected readonly choices = THEME_CHOICES;
  protected readonly label = LABEL;
}
