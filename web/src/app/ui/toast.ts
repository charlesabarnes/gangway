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
          class="pointer-events-auto w-full max-w-sm bg-paper p-3.5 text-sm shadow-lg"
          [class]="
            t.kind === 'error'
              ? 'shadow-[inset_0_0_0_1px_var(--gw-ink),inset_4px_0_0_var(--gw-danger)]'
              : 'shadow-[inset_0_0_0_1px_var(--gw-ink),inset_4px_0_0_var(--gw-flag)]'
          "
          [attr.role]="t.kind === 'error' ? 'alert' : 'status'"
          data-testid="toast"
        >
          <div class="flex items-start gap-3">
            <div class="min-w-0 flex-1">
              <p class="font-medium" [class]="t.kind === 'error' ? 'text-danger' : ''">
                {{ t.title }}
              </p>
              @if (t.detail) {
                <p class="mt-0.5 text-muted">{{ t.detail }}</p>
              }
              @if (t.requestId) {
                <p class="mt-1.5 font-mono text-xs text-muted">request {{ t.requestId }}</p>
              }
            </div>
            <button
              type="button"
              (click)="svc.dismiss(t.id)"
              class="text-muted hover:text-ink"
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
