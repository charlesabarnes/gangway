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
    <h2 class="mt-8 text-base font-semibold">Surfaces</h2>
    <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
      What answers besides the previews themselves. A surface that is off is a 404, as if it were
      never there.
    </p>
    <div
      class="mt-3 divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800"
      data-testid="surfaces"
    >
      @if (surfaces(); as sf) {
        <div class="flex flex-wrap items-start justify-between gap-3 p-5" data-testid="surface-mcp">
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-2 font-medium">
              <span
                class="size-2 rounded-full"
                [class]="sf.mcp.enabled ? 'bg-emerald-500' : 'bg-neutral-400'"
                aria-hidden="true"
              ></span
              >MCP {{ sf.mcp.enabled ? 'is on' : 'is off' }}
            </p>
            <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              Lets an agent deploy, check, read logs and destroy with four tools. It is one more
              public way in, so it starts off.
            </p>
            @if (sf.mcp.enabled) {
              <p class="mt-3 text-sm">
                URL: <code class="font-mono" data-testid="mcp-url">{{ sf.mcp.url }}</code>
              </p>
              <p class="mt-2 text-xs text-neutral-500">
                Claude Code, with an API token that has the deploy scope:
              </p>
              <pre
                class="mt-1 overflow-x-auto rounded-md bg-neutral-100 p-2 font-mono text-xs dark:bg-neutral-800"
                data-testid="mcp-snippet"
              >
claude mcp add --transport http gangway {{ sf.mcp.url }} --header "Authorization: Bearer gw_…"</pre>
              <p class="mt-2 text-xs text-neutral-500" data-testid="mcp-oauth">
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
        <div class="flex flex-wrap items-start justify-between gap-3 p-5" data-testid="surface-ui">
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-2 font-medium">
              <span class="size-2 rounded-full bg-emerald-500" aria-hidden="true"></span>The web UI
              is on
            </p>
            <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              This page. Turned off, it can only come back through the API with an admin-scoped
              token.
            </p>
            @if (!sf.ui.managedByConfig && !sf.adminTokenExists) {
              <p
                class="mt-2 text-sm text-amber-700 dark:text-amber-400"
                data-testid="ui-needs-token"
              >
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
            This page and every other will answer 404, and private previews will stop opening. Only
            this brings it back, with an admin-scoped API token:
          </p>
          <pre
            class="mt-2 overflow-x-auto rounded-md bg-neutral-100 p-2 font-mono text-xs text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
            data-testid="reenable-curl"
            >{{ sf.reenableUi }}</pre>
        </app-confirm-dialog>
      } @else {
        <p class="p-5 text-sm text-neutral-500">Loading…</p>
      }
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
