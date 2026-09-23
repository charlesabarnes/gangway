import { HttpClient } from '@angular/common/http';
import { Component, inject, model, signal, viewChild } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { OAuthGrant } from '../../core/api.types';
import { Clock } from '../../core/clock';
import { toProblem } from '../../core/problem';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { RelativeTimePipe } from '../../ui/relative-time.pipe';
import { ToastService } from '../../ui/toast';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

@Component({
  selector: 'app-connected-agents',
  host: { class: 'block' },
  imports: [ConfirmDialog, RelativeTimePipe],
  template: `
    <h2 class="mt-10 text-base font-semibold">Connected agents</h2>
    <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
      Apps you let act as you over MCP, such as claude.ai. They can do no more than you can.
    </p>
    <ul
      class="mt-3 divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800"
      data-testid="grants"
    >
      @for (g of grants(); track g.id) {
        <li
          class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm"
          data-testid="grant"
        >
          <span class="font-medium">{{ g.clientName }}</span>
          <span class="font-mono text-xs text-neutral-500">{{ hostOf(g.clientId) }}</span>
          <span class="text-xs text-neutral-500">{{ g.scopes.join(', ') }}</span>
          <span class="ml-auto text-xs text-neutral-500"
            >connected {{ g.createdAt | relativeTime: clock.now() }} ·
            {{
              g.lastUsedAt ? 'used ' + (g.lastUsedAt | relativeTime: clock.now()) : 'not used yet'
            }}</span
          >
          <button
            type="button"
            (click)="ask(g)"
            class="text-neutral-500 hover:text-red-600 dark:hover:text-red-400"
            data-testid="disconnect"
          >
            Disconnect
          </button>
        </li>
      } @empty {
        <li class="px-4 py-6 text-center text-sm text-neutral-500" data-testid="no-grants">
          None. An agent connects from its own side, and you approve it here.
        </li>
      }
    </ul>

    <app-confirm-dialog
      [heading]="'Disconnect ' + (pending()?.clientName ?? '') + '?'"
      confirmLabel="Disconnect"
      (confirmed)="disconnect()"
    >
      It loses access at once. To use it again, connect it again from its side.
    </app-confirm-dialog>
  `,
})
export class ConnectedAgents {
  readonly grants = model.required<OAuthGrant[]>();

  protected readonly clock = inject(Clock);
  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);
  private readonly dialog = viewChild.required(ConfirmDialog);

  protected readonly hostOf = hostOf;
  protected readonly pending = signal<OAuthGrant | null>(null);

  protected ask(g: OAuthGrant): void {
    this.pending.set(g);
    this.dialog().open();
  }

  protected async disconnect(): Promise<void> {
    const g = this.pending();
    if (!g) return;
    try {
      await firstValueFrom(this.#http.delete(`/v1/oauth/grants/${g.id}`));
      this.grants.update((gs) => gs.filter((x) => x.id !== g.id));
    } catch (err) {
      this.#toasts.problem(`Could not disconnect ${g.clientName}`, toProblem(err));
    }
  }
}
