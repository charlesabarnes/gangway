import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { ConsentRequest, OAuthScope } from '../../core/api.types';
import { HARD_NAVIGATE } from '../../core/auth.guard';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';

const SCOPE_HELP: Record<OAuthScope, string> = {
  read: 'See previews, their state and their logs.',
  deploy: 'Also deploy new previews, destroy them, and rebuild the ones you deployed.',
  update: 'Also rebuild any preview in place, including ones other people deployed.',
};

@Component({
  selector: 'app-connect',
  imports: [Btn],
  template: `
    <section class="mx-auto max-w-lg px-6 py-12">
      @if (request(); as r) {
        <h1 class="text-xl font-semibold tracking-tight">
          Connect {{ r.client.name }} to gangway?
        </h1>
        <div
          class="mt-5 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
          data-testid="who"
        >
          <dl class="grid grid-cols-[7rem_1fr] gap-y-2 text-sm">
            <dt class="text-neutral-500">App</dt>
            <dd class="font-medium" data-testid="client-name">{{ r.client.name }}</dd>
            <dt class="text-neutral-500">Published by</dt>
            <dd>
              <span class="font-mono font-semibold" data-testid="client-host">{{
                r.client.host
              }}</span>
            </dd>
            <dt class="text-neutral-500">Sends you to</dt>
            <dd>
              <span class="font-mono font-semibold" data-testid="redirect-host">{{
                r.redirectHost
              }}</span>
            </dd>
          </dl>
          <p class="mt-4 text-xs text-neutral-500">
            Only continue if you just asked {{ r.client.host }} to connect. It will act as you, on
            the MCP surface only, until you disconnect it under Account.
          </p>
        </div>

        <fieldset class="mt-6">
          <legend class="text-sm font-medium">It may</legend>
          <div class="mt-2 space-y-2">
            @for (s of r.requested; track s) {
              <label class="flex items-start gap-2.5 text-sm" [class.opacity-50]="!grantable(s)">
                <input
                  type="checkbox"
                  class="mt-0.5"
                  [checked]="chosen().has(s)"
                  [disabled]="!grantable(s) || busy()"
                  (change)="toggle(s)"
                  [attr.data-testid]="'scope-' + s"
                />
                <span
                  ><span class="font-mono text-xs font-medium">{{ s }}</span> — {{ help[s] }}
                  @if (!grantable(s)) {
                    <span class="text-neutral-500"> Your role does not cover this.</span>
                  }
                </span>
              </label>
            }
          </div>
        </fieldset>

        <div class="mt-8 flex items-center gap-3">
          <button
            appBtn
            type="button"
            [disabled]="busy() || chosen().size === 0"
            (click)="answer(true)"
            data-testid="approve"
          >
            Connect
          </button>
          <button
            appBtn
            variant="ghost"
            type="button"
            [disabled]="busy()"
            (click)="answer(false)"
            data-testid="deny"
          >
            Cancel
          </button>
        </div>
        @if (error(); as e) {
          <p class="mt-4 text-sm text-red-700 dark:text-red-400" role="alert" data-testid="error">
            {{ e }}
          </p>
        }
      } @else if (error(); as e) {
        <h1 class="text-xl font-semibold tracking-tight">Cannot connect</h1>
        <p
          class="mt-3 text-sm text-neutral-600 dark:text-neutral-400"
          role="alert"
          data-testid="error"
        >
          {{ e }}
        </p>
      } @else {
        <p class="text-sm text-neutral-500" data-testid="loading">Loading…</p>
      }
    </section>
  `,
})
export class Connect {
  readonly #http = inject(HttpClient);
  readonly #navigate = inject(HARD_NAVIGATE);
  readonly #id = inject(ActivatedRoute).snapshot.queryParamMap.get('request');

  protected readonly help = SCOPE_HELP;
  protected readonly request = signal<ConsentRequest | null>(null);
  protected readonly chosen = signal<ReadonlySet<OAuthScope>>(new Set());
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly grantableSet = computed(() => new Set(this.request()?.grantable ?? []));

  constructor() {
    void this.#load();
  }

  protected grantable(s: OAuthScope): boolean {
    return this.grantableSet().has(s);
  }

  async #load(): Promise<void> {
    if (!this.#id) {
      this.error.set('This link is missing its request. Start again from the app that sent you.');
      return;
    }
    try {
      const { request } = await firstValueFrom(
        this.#http.get<{ request: ConsentRequest }>(
          `/v1/oauth/requests/${encodeURIComponent(this.#id)}`,
        ),
      );
      this.request.set(request);
      this.chosen.set(new Set(request.grantable));
    } catch (e) {
      this.error.set(toProblem(e).detail);
    }
  }

  protected toggle(s: OAuthScope): void {
    const next = new Set(this.chosen());
    if (!next.delete(s)) next.add(s);
    this.chosen.set(next);
  }

  protected async answer(approve: boolean): Promise<void> {
    const r = this.request();
    if (!r || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const body = approve
        ? { approve, scopes: r.requested.filter((s) => this.chosen().has(s)) }
        : { approve };
      const { redirect } = await firstValueFrom(
        this.#http.post<{ redirect: string }>(
          `/v1/oauth/requests/${encodeURIComponent(r.id)}`,
          body,
        ),
      );
      this.#navigate(redirect);
    } catch (e) {
      this.error.set(toProblem(e).detail);
      this.busy.set(false);
    }
  }
}
