import { Component, input } from '@angular/core';

@Component({
  selector: 'app-empty-state',
  template: `
    <div class="rounded-lg border border-dashed border-neutral-300 px-6 py-14 text-center dark:border-neutral-700" data-testid="empty">
      <p class="font-medium">{{ heading() }}</p>
      <div class="mx-auto mt-2 max-w-prose text-sm text-neutral-600 dark:text-neutral-400"><ng-content /></div>
    </div>
  `,
})
export class EmptyState {
  readonly heading = input.required<string>();
}
