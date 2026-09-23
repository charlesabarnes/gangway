import { Component, input, output } from '@angular/core';
import type { Runtime, RuntimeId } from '../../core/api.types';
import { BrandIcon } from '../../ui/brand-icon';
import { RUNTIME_LOOKS, tint } from './looks';

@Component({
  selector: 'app-runtime-starters',
  host: { class: 'block' },
  imports: [BrandIcon],
  template: `
    <h2 class="mt-8 text-sm font-medium text-neutral-500">Start from a runtime</h2>
    <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
      Start with a small example, or drop in your own files below. You can edit them in the browser.
    </p>
    <ul class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="runtimes">
      @for (r of runtimes(); track r.id) {
        @let look = looks[r.id];
        <li>
          <button
            type="button"
            (click)="start.emit(r)"
            [disabled]="busy()"
            [attr.data-testid]="'starter-' + r.id"
            [title]="r.name + ' — ' + r.description"
            [style.--brand]="look.color ?? 'currentColor'"
            class="group flex h-full w-full items-start gap-3 rounded-xl border border-neutral-200 bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-[var(--brand)] hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)] disabled:translate-y-0 disabled:opacity-50 disabled:shadow-none dark:border-neutral-800 dark:bg-neutral-900"
          >
            <span
              class="grid size-11 shrink-0 place-items-center rounded-lg transition group-hover:scale-105"
              [style.background-color]="tint(look.color)"
            >
              @if (starting() === r.id) {
                <span
                  class="block size-5 animate-spin rounded-full border-2 border-[var(--brand)] border-t-transparent"
                  data-testid="starting"
                ></span>
              } @else {
                <app-brand-icon [path]="look.path" [color]="look.color" [size]="24" />
              }
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-2">
                <span class="font-medium">{{ look.name }}</span>
                @if (r.language !== look.name) {
                  <span
                    class="rounded-full bg-neutral-100 px-1.5 py-px text-[10px] text-neutral-500 dark:bg-neutral-800"
                    >{{ r.language }}</span
                  >
                }
              </span>
              <span class="mt-0.5 block text-xs text-neutral-600 dark:text-neutral-400">{{
                look.tagline
              }}</span>
              <span class="mt-2 block truncate font-mono text-[10px] text-neutral-400">{{
                r.image
              }}</span>
            </span>
          </button>
        </li>
      } @empty {
        <li class="text-sm text-neutral-500" data-testid="runtimes-loading">
          {{ error() ?? 'Loading runtimes…' }}
        </li>
      }
    </ul>
  `,
})
export class RuntimeStarters {
  readonly runtimes = input.required<Runtime[]>();
  readonly busy = input.required<boolean>();
  readonly starting = input.required<RuntimeId | null>();
  readonly error = input.required<string | null>();
  readonly start = output<Runtime>();

  protected readonly looks = RUNTIME_LOOKS;
  protected readonly tint = tint;
}
