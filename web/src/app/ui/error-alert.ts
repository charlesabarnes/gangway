import { Component, input } from '@angular/core';
import type { ProblemError } from '../core/problem';

@Component({
  selector: 'app-error-alert',
  host: {
    role: 'alert',
    class: 'block bg-danger/10 text-sm text-ink shadow-[inset_3px_0_0_var(--gw-danger)]',
  },
  template: `
    @if (problem(); as e) {
      @if (heading()) {
        <p class="font-medium">{{ heading() }}</p>
      }
      <p [class.mt-1]="heading() !== ''">
        {{ lead() }}{{ e.detail }}
        @if (e.requestId) {
          <span class="font-mono text-xs opacity-70"> (request {{ e.requestId }})</span>
        }
      </p>
    }
    <ng-content />
  `,
})
export class ErrorAlert {
  readonly problem = input<ProblemError | null>(null);
  readonly heading = input('');
  readonly lead = input('');
}
