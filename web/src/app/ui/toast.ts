import { Component, Injectable, inject, signal } from '@angular/core';
import type { ProblemError } from '../core/problem';

export type Toast = {
  id: number;
  kind: 'error' | 'info';
  title: string;
  detail?: string;
  requestId?: string;
};

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  #next = 1;

  info(title: string, detail?: string): void {
    this.#push({ kind: 'info', title, ...(detail ? { detail } : {}) }, 4_000);
  }

  /** Errors stay until dismissed: the request id on them is what to quote when asking why. */
  problem(what: string, p: ProblemError): void {
    this.#push(
      {
        kind: 'error',
        title: what,
        detail: p.detail,
        ...(p.requestId ? { requestId: p.requestId } : {}),
      },
      null,
    );
  }

  dismiss(id: number): void {
    this.toasts.update((ts) => ts.filter((t) => t.id !== id));
  }

  #push(t: Omit<Toast, 'id'>, ttlMs: number | null): void {
    const id = this.#next++;
    this.toasts.update((ts) => [...ts, { ...t, id }].slice(-4));
    if (ttlMs !== null) setTimeout(() => this.dismiss(id), ttlMs);
  }
}

@Component({
  selector: 'app-toasts',
  template: `
    <div
      class="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-end gap-2 p-4"
      aria-live="polite"
    >
      @for (t of svc.toasts(); track t.id) {
        <div
          class="pointer-events-auto w-full max-w-sm rounded-lg border bg-white p-3.5 text-sm shadow-lg dark:bg-neutral-900"
          [class]="
            t.kind === 'error'
              ? 'border-red-300 dark:border-red-900'
              : 'border-neutral-200 dark:border-neutral-800'
          "
          [attr.role]="t.kind === 'error' ? 'alert' : 'status'"
          data-testid="toast"
        >
          <div class="flex items-start gap-3">
            <div class="min-w-0 flex-1">
              <p
                class="font-medium"
                [class]="t.kind === 'error' ? 'text-red-700 dark:text-red-400' : ''"
              >
                {{ t.title }}
              </p>
              @if (t.detail) {
                <p class="mt-0.5 text-neutral-600 dark:text-neutral-400">{{ t.detail }}</p>
              }
              @if (t.requestId) {
                <p class="mt-1.5 font-mono text-xs text-neutral-400">request {{ t.requestId }}</p>
              }
            </div>
            <button
              type="button"
              (click)="svc.dismiss(t.id)"
              class="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      }
    </div>
  `,
})
export class Toasts {
  protected readonly svc = inject(ToastService);
}
