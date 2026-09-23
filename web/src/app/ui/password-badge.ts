import { Component, computed, input } from '@angular/core';
import type { PreviewAccess } from '../core/api.types';

/** What each protected mode is called on screen. `open` shows nothing. */
export const ACCESS_BADGE: Record<
  Exclude<PreviewAccess, 'open'>,
  { label: string; title: string }
> = {
  password: {
    label: 'Password',
    title: 'Everyone must enter the password, including people signed in to gangway.',
  },
  'signed-in': {
    label: 'Gangway users',
    title: 'Only people signed in to gangway can open it. There is no password.',
  },
  either: {
    label: 'Password or gangway login',
    title: 'People signed in to gangway go straight in; anyone else needs the password.',
  },
  'signed-in+password': {
    label: 'Gangway login + password',
    title: 'A private preview with a password: sign in to gangway, then enter the password.',
  },
};

/**
 * A lock pill naming who can open a preview, as the server resolved it. Nothing for an
 * open one.
 */
@Component({
  selector: 'app-password-badge',
  template: `
    @if (badge(); as b) {
      <span
        class="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-300"
        [title]="b.title"
        data-testid="password-badge"
      >
        <svg
          viewBox="0 0 16 16"
          class="size-3"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          aria-hidden="true"
        >
          <rect x="3" y="7" width="10" height="7" rx="1.5" />
          <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
        </svg>
        {{ b.label }}
      </span>
    }
  `,
})
export class PasswordBadge {
  readonly access = input.required<PreviewAccess | undefined>();
  protected readonly badge = computed(() => {
    const a = this.access();
    return a && a !== 'open' ? ACCESS_BADGE[a] : null;
  });
}
