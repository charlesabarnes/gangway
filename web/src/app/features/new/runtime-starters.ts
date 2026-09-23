import { Component, input, output } from '@angular/core';
import type { Runtime, RuntimeId } from '../../core/api.types';
import { BrandIcon } from '../../ui/brand-icon';
import { RUNTIME_LOOKS, tint } from './looks';

@Component({
  selector: 'app-runtime-starters',
  host: { class: 'block' },
  imports: [BrandIcon],
  template: `
    <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <h2 class="gw-label">Start from a runtime</h2>
      <p class="text-sm text-muted">
        Start with a small example, or drop in your own files below. You can edit them in the
        browser.
      </p>
    </div>
    <ul
      class="mt-3 grid border-t border-l border-rule sm:grid-cols-2 lg:grid-cols-4"
      data-testid="runtimes"
    >
      @for (r of runtimes(); track r.id) {
        @let look = looks[r.id];
        <li class="border-r border-b border-rule">
          <button
            type="button"
            (click)="start.emit(r)"
            [disabled]="busy()"
            [attr.data-testid]="'starter-' + r.id"
            [title]="r.name + ' — ' + r.description"
            [style.--brand]="look.color ?? 'currentColor'"
            class="group flex h-full w-full items-start gap-3 bg-surface p-4 text-left transition hover:bg-paper hover:shadow-[inset_0_0_0_1px_var(--gw-ink)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-flag disabled:opacity-50 disabled:hover:bg-surface disabled:hover:shadow-none"
          >
            <span
              class="grid size-11 shrink-0 place-items-center"
              [style.background-color]="tint(look.color)"
            >
              @if (starting() === r.id) {
                <span
                  class="block size-5 animate-spin border-2 border-[var(--brand)] border-t-transparent"
                  data-testid="starting"
                ></span>
              } @else {
                <app-brand-icon [path]="look.path" [color]="look.color" [size]="24" />
              }
            </span>
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="flex items-center gap-2">
                <span class="text-base font-medium">{{ look.name }}</span>
                @if (r.language !== look.name) {
                  <span class="gw-chip text-[10px] text-muted">{{ r.language }}</span>
                }
              </span>
              <span class="block text-[13px] leading-snug text-muted">{{ look.tagline }}</span>
              <span class="mt-1.5 block truncate font-mono text-[11px] text-muted">{{
                r.image
              }}</span>
            </span>
          </button>
        </li>
      } @empty {
        <li
          class="border-r border-b border-rule p-4 text-sm text-muted"
          data-testid="runtimes-loading"
        >
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
