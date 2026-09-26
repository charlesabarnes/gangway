import { Component, computed, input } from '@angular/core';

/** Where content will be while it loads, laid out like it: cards, rows or lines of text. */
@Component({
  selector: 'app-skeleton',
  host: { 'aria-busy': 'true', role: 'status', '[attr.aria-label]': 'label()' },
  template: `
    @switch (kind()) {
      @case ('cards') {
        <div [class]="grid()">
          @for (i of slots(); track i) {
            <div class="flex flex-col gap-3">
              <div class="gw-skeleton" [style.aspect-ratio]="ratio()"></div>
              <div class="gw-skeleton h-3 w-1/3"></div>
              <div class="gw-skeleton h-5 w-2/3"></div>
            </div>
          }
        </div>
      }
      @case ('rows') {
        <div class="flex flex-col divide-y divide-rule border-y border-rule">
          @for (i of slots(); track i) {
            <div class="flex items-center gap-4 py-4">
              <div class="gw-skeleton size-8 shrink-0"></div>
              <div class="flex flex-1 flex-col gap-2">
                <div class="gw-skeleton h-4 w-1/3"></div>
                <div class="gw-skeleton h-3 w-1/2"></div>
              </div>
            </div>
          }
        </div>
      }
      @default {
        <div class="flex flex-col gap-2.5">
          @for (i of slots(); track i) {
            <div
              class="gw-skeleton h-4"
              [style.width.%]="i === slots().length - 1 ? 60 : 100"
            ></div>
          }
        </div>
      }
    }
  `,
})
export class Skeleton {
  readonly kind = input<'cards' | 'rows' | 'lines'>('lines');
  readonly count = input(3);
  readonly ratio = input('16 / 10');
  readonly grid = input('grid gap-6 sm:grid-cols-2 lg:grid-cols-3');
  readonly label = input('Loading');
  protected readonly slots = computed(() => Array.from({ length: this.count() }, (_, i) => i));
}
