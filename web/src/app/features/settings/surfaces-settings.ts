import { HttpClient } from '@angular/common/http';
import { Component, inject, model, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { DISABLE_UI_PHRASE, type Surfaces } from '../../core/api.types';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { ManagedBadge } from '../../ui/managed-badge';
import { ToastService } from '../../ui/toast';

@Component({
  selector: 'app-surfaces-settings',
  host: { class: 'block' },
  imports: [Btn, ConfirmDialog, ManagedBadge, RouterLink],
  template: `
    <div class="gw-section">
      <div class="flex flex-col gap-1">
        <h2 class="gw-h2">Surfaces</h2>
        <p class="gw-section-note">
          What answers besides the previews themselves. A surface that is off is a 404, as if it
          were never there.
        </p>
      </div>
      <div class="flex flex-col divide-y divide-rule" data-testid="surfaces">
        @if (surfaces(); as sf) {
          <div
            class="flex flex-wrap items-start justify-between gap-5 pb-[18px]"
            data-testid="surface-mcp"
          >
            <div class="flex min-w-0 flex-1 flex-col gap-2">
              <p class="flex items-center gap-2 text-[17px] font-medium">
                <span
                  class="size-[11px] shrink-0"
                  [class]="sf.mcp.enabled ? 'bg-ok' : 'bg-muted'"
                  aria-hidden="true"
                ></span
                >MCP {{ sf.mcp.enabled ? 'is on' : 'is off' }}
              </p>
              <p class="text-sm leading-normal text-muted">
                Lets an agent deploy, check, read logs and destroy with four tools. It is one more
                public way in, so it starts off.
              </p>
              @if (sf.mcp.enabled) {
                <p class="flex items-baseline gap-2 text-sm">
                  <span class="gw-label">URL</span
                  ><code class="font-mono text-[13px]" data-testid="mcp-url">{{ sf.mcp.url }}</code>
                </p>
                <p class="text-xs text-muted">
                  Claude Code, with an API token that has the deploy scope:
                </p>
                <pre
                  class="overflow-x-auto bg-log px-3 py-2.5 font-mono text-xs leading-normal whitespace-pre-wrap text-log-fg"
                  data-testid="mcp-snippet"
                >
claude mcp add --transport http gangway {{ sf.mcp.url }} --header "Authorization: Bearer gw_…"</pre>
                <p class="text-xs text-muted" data-testid="mcp-oauth">
                  Or with no token: add the URL as a custom connector in claude.ai (or
                  <code class="font-mono"
                    >claude mcp add --transport http gangway {{ sf.mcp.url }}</code
                  >
                  and <code class="font-mono">/mcp</code> in Claude Code). You will be sent here to
                  approve it, and can disconnect it under Account.
                </p>
              }
            </div>
            @if (sf.mcp.managedByConfig) {
              <app-managed-badge data-testid="mcp-managed" />
            } @else {
              <button
                appBtn
                size="sm"
                [variant]="sf.mcp.enabled ? 'ghost' : 'primary'"
                type="button"
                [disabled]="saving() !== null"
                (click)="setMcp(!sf.mcp.enabled)"
                data-testid="mcp-toggle"
              >
                {{ sf.mcp.enabled ? 'Turn off' : 'Turn on' }}
              </button>
            }
          </div>
          <div
            class="flex flex-wrap items-start justify-between gap-5 pt-[18px]"
            data-testid="surface-ui"
          >
            <div class="flex min-w-0 flex-1 flex-col gap-2">
              <p class="flex items-center gap-2 text-[17px] font-medium">
                <span class="size-[11px] shrink-0 bg-ok" aria-hidden="true"></span>The web UI is on
              </p>
              <p class="text-sm leading-normal text-muted">
                This page. Turned off, it can only come back through the API with an admin-scoped
                token.
              </p>
              @if (!sf.ui.managedByConfig && !sf.adminTokenExists) {
                <p class="text-sm text-warn" data-testid="ui-needs-token">
                  To turn it off, first
                  <a routerLink="/account" class="underline underline-offset-2"
                    >create an API token with the admin scope</a
                  >: it is the way back in.
                </p>
              }
            </div>
            @if (sf.ui.managedByConfig) {
              <app-managed-badge data-testid="ui-managed" />
            } @else {
              <button
                appBtn
                variant="ghost"
                size="sm"
                type="button"
                [disabled]="saving() !== null || !sf.adminTokenExists"
                (click)="dialog().open()"
                data-testid="ui-toggle"
              >
                Turn off
              </button>
            }
          </div>
          <app-confirm-dialog
            heading="Turn the web UI off?"
            confirmLabel="Turn the UI off"
            [phrase]="phrase"
            (confirmed)="disableUi()"
          >
            <p>
              This page and every other will answer 404, and private previews will stop opening.
              Only this brings it back, with an admin-scoped API token:
            </p>
            <pre
              class="mt-2 overflow-x-auto bg-log p-2 font-mono text-xs text-log-fg"
              data-testid="reenable-curl"
              >{{ sf.reenableUi }}</pre>
          </app-confirm-dialog>
        } @else {
          <p class="text-sm text-muted">Loading…</p>
        }
      </div>
    </div>
  `,
})
export class SurfacesSettings {
  readonly saving = model.required<string | null>();

  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);
  protected readonly dialog = viewChild.required(ConfirmDialog);

  protected readonly phrase = DISABLE_UI_PHRASE;
  protected readonly surfaces = signal<Surfaces | null>(null);

  constructor() {
    void this.#load();
  }

  async #load(): Promise<void> {
    try {
      this.surfaces.set(
        (await firstValueFrom(this.#http.get<{ surfaces: Surfaces }>('/v1/surfaces'))).surfaces,
      );
    } catch (e) {
      this.#toasts.problem('Could not load the surfaces', toProblem(e));
    }
  }

  async #put(
    body: { ui?: boolean; mcp?: boolean; confirm?: string },
    done: string,
  ): Promise<boolean> {
    if (this.saving()) return false;
    this.saving.set('surfaces');
    try {
      this.surfaces.set(
        (await firstValueFrom(this.#http.put<{ surfaces: Surfaces }>('/v1/surfaces', body)))
          .surfaces,
      );
      this.#toasts.info(done);
      return true;
    } catch (e) {
      this.#toasts.problem('Could not change the surface', toProblem(e));
      return false;
    } finally {
      this.saving.set(null);
    }
  }

  protected setMcp(on: boolean): Promise<boolean> {
    return this.#put(
      { mcp: on },
      on ? 'MCP is on' : 'MCP is off; open agent sessions were dropped',
    );
  }

  protected disableUi(): Promise<boolean> {
    return this.#put(
      { ui: false, confirm: DISABLE_UI_PHRASE },
      'The web UI is off. Use the curl you were shown to bring it back.',
    );
  }
}
