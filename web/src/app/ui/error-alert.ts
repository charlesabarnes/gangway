import { Component, input } from '@angular/core';
import type { ProblemError } from '../core/problem';

@Component({
  selector: 'app-error-alert',
  host: {
    role: 'alert',
    class:
      'block rounded-md border border-red-200 bg-red-50 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300',
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
