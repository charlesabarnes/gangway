import { Component, computed, input } from '@angular/core';

/**
 * ADR-0023: a lock pill for a preview that is behind a password RIGHT NOW (the server has
 * already resolved `inherit` against Settings). Says so when being signed in gets past it,
 * because then the operator never sees the form and could think the password is not on.
 */
@Component({
  selector: 'app-password-badge',
  template: `
    @if (active()) {
      <span class="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-300"
        [title]="title()" data-testid="password-badge">
        <svg viewBox="0 0 16 16" class="size-3" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>
        {{ skips() ? 'Password · you skip it' : 'Password' }}
      </span>
    }
  `,
})
export class PasswordBadge {
  readonly active = input.required<boolean>();
  readonly skips = input(false);
  protected readonly title = computed(() => this.skips()
    ? 'Visitors must enter a password. People signed in to gangway go straight in, so you will not see the form.'
    : 'Everyone must enter a password to open this preview, including people signed in to gangway.');
}
