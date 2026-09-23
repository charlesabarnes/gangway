import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { toProblem, type ProblemError } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ToastService } from '../../ui/toast';
import { FIELD, LABEL } from './fields';

function refusal(p: ProblemError): string {
  switch (p.status) {
    case 403:
      return 'The current password is wrong.';
    case 429:
      return `Too many attempts. Try again in ${p.retryAfter ?? 60} s.`;
    default:
      return p.detail;
  }
}

@Component({
  selector: 'app-change-password',
  host: { class: 'block' },
  imports: [Btn],
  template: `
    <h2 class="mt-10 text-base font-semibold">Password</h2>
    <form
      (submit)="submit($event)"
      novalidate
      class="mt-3 grid gap-4 sm:grid-cols-3"
      data-testid="password-form"
    >
      <div>
        <label for="current" [class]="label">Current</label
        ><input
          id="current"
          type="password"
          autocomplete="current-password"
          [class]="field"
          [value]="current()"
          (input)="current.set($any($event.target).value)"
          data-testid="current"
        />
      </div>
      <div>
        <label for="next" [class]="label">New</label
        ><input
          id="next"
          type="password"
          autocomplete="new-password"
          [class]="field"
          [value]="next()"
          (input)="next.set($any($event.target).value)"
          data-testid="next"
        />
      </div>
      <div>
        <label for="again" [class]="label">New, again</label
        ><input
          id="again"
          type="password"
          autocomplete="new-password"
          [class]="field"
          [value]="again()"
          (input)="again.set($any($event.target).value)"
          data-testid="again"
        />
      </div>
      <div class="flex items-center gap-3 sm:col-span-3">
        <button
          appBtn
          variant="ghost"
          type="submit"
          [disabled]="busy() || !ready()"
          data-testid="change-password"
        >
          Change password
        </button>
        <span class="text-xs text-neutral-500"
          >At least 12 characters. Your other sessions will be logged out.</span
        >
      </div>
      @if (error(); as e) {
        <p
          class="text-sm text-red-700 sm:col-span-3 dark:text-red-400"
          role="alert"
          data-testid="pw-error"
        >
          {{ e }}
        </p>
      }
    </form>
  `,
})
export class ChangePassword {
  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);

  protected readonly field = FIELD;
  protected readonly label = LABEL;

  protected readonly current = signal('');
  protected readonly next = signal('');
  protected readonly again = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly ready = computed(
    () => this.current() !== '' && this.next().length >= 12 && this.next() === this.again(),
  );

  protected async submit(e: Event): Promise<void> {
    e.preventDefault();
    if (this.busy() || !this.ready()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(
        this.#http.post('/v1/auth/password', { current: this.current(), next: this.next() }),
      );
      this.current.set('');
      this.next.set('');
      this.again.set('');
      this.#toasts.info('Password changed', 'Your other sessions were logged out.');
    } catch (err) {
      this.error.set(refusal(toProblem(err)));
    } finally {
      this.busy.set(false);
    }
  }
}
