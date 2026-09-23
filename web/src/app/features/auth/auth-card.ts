import { Component, input } from '@angular/core';

/** The frame login and setup share: no app header, one centred card. */
@Component({
  selector: 'app-auth-card',
  template: `
    <main class="flex min-h-dvh items-center justify-center px-6 py-12">
      <div class="w-full max-w-sm">
        <div class="mb-8 flex items-center gap-2.5">
          <span class="size-2.5 rounded-full bg-accent" aria-hidden="true"></span>
          <span class="font-semibold tracking-tight">gangway</span>
        </div>
        <h1 class="text-xl font-semibold tracking-tight">{{ heading() }}</h1>
        <p class="mt-1.5 text-sm text-neutral-600 dark:text-neutral-400">
          <ng-content select="[lede]" />
        </p>
        <div class="mt-8"><ng-content /></div>
      </div>
    </main>
  `,
})
export class AuthCard {
  readonly heading = input.required<string>();
}

/** Shared by both forms so the two pages cannot drift apart. */
export const FIELD =
  'mt-1.5 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm shadow-xs ' +
  'placeholder:text-neutral-400 focus:border-accent focus:outline-2 focus:outline-accent/30 ' +
  'dark:border-neutral-700 dark:bg-neutral-900';
export const LABEL = 'block text-sm font-medium text-neutral-800 dark:text-neutral-200';
export const ALERT =
  'rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300';
