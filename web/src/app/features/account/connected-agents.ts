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
  host: { class: 'gw-section border-b-0' },
  imports: [ConfirmDialog, RelativeTimePipe],
  template: `
    <div class="flex flex-col gap-1">
      <h2 class="gw-h2">Connected agents</h2>
      <p class="gw-section-note">
        Apps you let act as you over MCP, such as claude.ai. They can do no more than you can.
      </p>
    </div>
    <ul class="border-t border-ink" data-testid="grants">
      @for (g of grants(); track g.id) {
        <li
          class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule py-2.5 text-sm"
          data-testid="grant"
        >
          <span class="text-[15px] font-medium">{{ g.clientName }}</span>
          <code class="font-mono text-xs text-muted">{{ hostOf(g.clientId) }}</code>
          <span class="text-[13px] text-muted">{{ g.scopes.join(', ') }}</span>
          <span class="ml-auto text-[13px] text-muted"
            >connected {{ g.createdAt | relativeTime: clock.now() }} ·
            {{
              g.lastUsedAt ? 'used ' + (g.lastUsedAt | relativeTime: clock.now()) : 'not used yet'
            }}</span
          >
          <button
            type="button"
            (click)="ask(g)"
            class="gw-action hover:!text-danger"
            data-testid="disconnect"
          >
            Disconnect
          </button>
        </li>
      } @empty {
        <li class="border-b border-rule py-2.5 text-sm text-muted" data-testid="no-grants">
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
