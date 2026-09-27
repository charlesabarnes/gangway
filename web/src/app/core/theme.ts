import { DOCUMENT, Injectable, computed, effect, inject, signal } from '@angular/core';

export type ThemeChoice = 'system' | 'light' | 'dark';
export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

// A cookie on the parent domain, so the app and every preview share one choice.
export const THEME_KEY = 'gw-theme';

export function readThemeCookie(doc: Document): 'light' | 'dark' | null {
  const m = /(?:^|;\s*)gw-theme=(light|dark)(?:;|$)/.exec(doc.cookie);
  return m ? (m[1] as 'light' | 'dark') : null;
}

export function writeThemeCookie(doc: Document, value: 'light' | 'dark' | null): void {
  const { hostname, protocol } = doc.location;
  const parent = hostname.split('.').slice(1).join('.');
  const domain = parent.includes('.') ? `; domain=${parent}` : '';
  const secure = protocol === 'https:' ? '; secure' : '';
  const life = value ? 'max-age=31536000' : 'max-age=0';
  doc.cookie = `${THEME_KEY}=${value ?? ''}; path=/; ${life}; samesite=lax${domain}${secure}`;
}

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
    this.#doc.addEventListener('visibilitychange', () => this.choice.set(this.#stored()));
    effect(() => {
      this.#doc.documentElement.dataset['theme'] = this.dark() ? 'dark' : 'light';
    });
  }

  set(choice: ThemeChoice): void {
    this.choice.set(choice);
    writeThemeCookie(this.#doc, choice === 'system' ? null : choice);
  }

  #stored(): ThemeChoice {
    const shared = readThemeCookie(this.#doc);
    if (shared) return shared;
    // Before the cookie the choice lived in this host's storage; move it over once.
    try {
      const v = localStorage.getItem(THEME_KEY);
      localStorage.removeItem(THEME_KEY);
      if (v === 'light' || v === 'dark') {
        writeThemeCookie(this.#doc, v);
        return v;
      }
    } catch {
      // Storage can be blocked; the cookie is what counts.
    }
    return 'system';
  }
}
