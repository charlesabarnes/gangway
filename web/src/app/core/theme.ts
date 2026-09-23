import { DOCUMENT, Injectable, computed, effect, inject, signal } from '@angular/core';

export type ThemeChoice = 'system' | 'light' | 'dark';
export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

/** Also read by the inline script in index.html, which applies the theme before the app boots. */
export const THEME_KEY = 'gw-theme';

/**
 * The colour theme. `<html data-theme>` always holds the one in effect ("light" or "dark"), and
 * the stylesheet keys off that rather than the media query, so a choice overrides the system.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly #doc = inject(DOCUMENT);
  readonly #media =
    typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  readonly #systemDark = signal(this.#media?.matches ?? false);

  readonly choice = signal<ThemeChoice>(this.#stored());
  readonly dark = computed(() =>
    this.choice() === 'system' ? this.#systemDark() : this.choice() === 'dark',
  );

  constructor() {
    this.#media?.addEventListener('change', (e) => this.#systemDark.set(e.matches));
    effect(() => {
      this.#doc.documentElement.dataset['theme'] = this.dark() ? 'dark' : 'light';
    });
  }

  set(choice: ThemeChoice): void {
    this.choice.set(choice);
    try {
      if (choice === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, choice);
    } catch {
      // Storage can be blocked; the choice still holds for this page.
    }
  }

  #stored(): ThemeChoice {
    try {
      const v = localStorage.getItem(THEME_KEY);
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch {
      return 'system';
    }
  }
}
