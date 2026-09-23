import { Component, input } from '@angular/core';

@Component({
  selector: 'app-empty-state',
  template: `
    <div class="border border-dashed border-rule px-6 py-10 text-center" data-testid="empty">
      <p class="font-serif text-xl italic">{{ heading() }}</p>
      <div class="mx-auto mt-1.5 max-w-prose text-sm text-muted">
        <ng-content />
      </div>
    </div>
  `,
})
export class EmptyState {
  readonly heading = input.required<string>();
}
