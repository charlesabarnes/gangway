import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  DEFAULT_SECRET_TARGETS,
  type ConsentRequest,
  type OAuthScope,
  type SecretTargets,
} from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { HARD_NAVIGATE } from '../../core/auth.guard';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { SecretTargetsPicker } from '../secrets/secret-targets';
import { Skeleton } from '../../ui/skeleton';

const SCOPE_HELP: Record<OAuthScope, string> = {
  read: 'See previews, their state and their logs.',
  deploy: 'Also deploy new previews, destroy them, and rebuild the ones you deployed.',
  update: 'Also rebuild any preview in place, including ones other people deployed.',
  artifacts:
    'Instead of the above: deploy artifacts and static sites only, never a container, and see, rebuild and destroy only what it deployed itself. For an agent you do not fully trust.',
  projects:
    'Also connect repositories for pull-request previews: add a repository to gangway and hand back its workflow file.',
  themes:
    "Also make and change artifact themes, and choose the server's default: they restyle everyone's artifacts.",
  secrets:
    'Also set and remove secrets (API keys, database URLs) where you choose below. Write-only: it sees names, never values.',
};

// Picking one of these switches off the others: artifacts means keeping the agent to its own.
const EXCLUSIVE: Partial<Record<OAuthScope, readonly OAuthScope[]>> = {
  artifacts: ['read', 'deploy', 'update', 'projects'],
  read: ['artifacts'],
  deploy: ['artifacts'],
  update: ['artifacts'],
  projects: ['artifacts'],
};

@Component({
  selector: 'app-connect',
  imports: [Btn, SecretTargetsPicker, Skeleton],
  template: `
    <section class="mx-auto max-w-lg px-4 py-12 sm:px-6">
      <div class="gw-neatline-strong flex flex-col gap-7 bg-paper p-8 sm:p-10">
        @if (request(); as r) {
          <h1 class="m-0 font-serif text-4xl leading-tight font-normal italic">
            Connect {{ r.client.name }} to gangway?
          </h1>
          <div class="border-t border-ink pt-4" data-testid="who">
            <dl class="grid grid-cols-[7rem_1fr] gap-y-2 text-[15px]">
              <dt class="text-muted">App</dt>
              <dd class="font-medium" data-testid="client-name">{{ r.client.name }}</dd>
              <dt class="text-muted">Published by</dt>
              <dd>
                @if (r.client.verified) {
                  <span class="font-mono font-semibold" data-testid="client-host">{{
                    r.client.host
                  }}</span>
                } @else {
                  <span class="text-warn" data-testid="client-unverified"
                    >Not verified: it registered itself, so the name is its own claim</span
                  >
                }
              </dd>
              <dt class="text-muted">Sends you to</dt>
              <dd>
                <span class="font-mono font-semibold" data-testid="redirect-host">{{
                  r.redirectHost
                }}</span>
              </dd>
            </dl>
            <p class="mt-4 text-[13px] leading-snug text-muted">
              Only continue if you just asked
              {{ r.client.verified ? r.client.host : r.client.name }} to connect. It will act as
              you, on the MCP surface only, until you disconnect it under Account.
            </p>
          </div>

          <fieldset>
            <legend class="gw-label">It may</legend>
            <div class="mt-2 flex flex-col gap-2">
              @for (s of r.offered; track s) {
                <label
                  class="flex items-start gap-2.5 text-sm leading-snug"
                  [class.opacity-50]="!grantable(s)"
                >
                  <input
                    type="checkbox"
                    class="gw-box mt-[3px]"
                    [checked]="chosen().has(s)"
                    [disabled]="!grantable(s) || busy()"
                    (change)="toggle(s)"
                    [attr.data-testid]="'scope-' + s"
                  />
                  <span
                    ><code class="font-mono text-xs font-medium">{{ s }}</code> — {{ help[s] }}
                    @if (!grantable(s)) {
                      <span class="text-muted"> Your role does not cover this.</span>
                    }
                  </span>
                </label>
              }
            </div>
            @if (chosen().has('secrets')) {
              <app-secret-targets [(value)]="targets" [disabled]="busy()" [wide]="canWide()" />
            }
          </fieldset>

          <div class="flex items-center gap-3">
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
            <p class="text-sm text-danger" role="alert" data-testid="error">
              {{ e }}
            </p>
          }
        } @else if (error(); as e) {
          <h1 class="m-0 font-serif text-4xl leading-tight font-normal italic">Cannot connect</h1>
          <p class="text-sm text-muted" role="alert" data-testid="error">
            {{ e }}
          </p>
        } @else {
          <app-skeleton [count]="3" data-testid="loading" />
        }
      </div>
    </section>
  `,
})
export class Connect {
  readonly #http = inject(HttpClient);
  readonly #navigate = inject(HARD_NAVIGATE);
  readonly #auth = inject(AuthService);
  readonly #id = inject(ActivatedRoute).snapshot.queryParamMap.get('request');

  protected readonly help = SCOPE_HELP;
  protected readonly request = signal<ConsentRequest | null>(null);
  protected readonly chosen = signal<ReadonlySet<OAuthScope>>(new Set());
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly grantableSet = computed(() => new Set(this.request()?.grantable ?? []));
  protected readonly targets = signal<SecretTargets>(DEFAULT_SECRET_TARGETS);
  protected readonly canWide = computed(() => this.#auth.can('repos.secrets'));

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
      this.chosen.set(new Set(request.requested.filter((s) => request.grantable.includes(s))));
    } catch (e) {
      this.error.set(toProblem(e).detail);
    }
  }

  protected toggle(s: OAuthScope): void {
    const next = new Set(this.chosen());
    if (!next.delete(s)) {
      next.add(s);
      for (const off of EXCLUSIVE[s] ?? []) next.delete(off);
    }
    this.chosen.set(next);
  }

  protected async answer(approve: boolean): Promise<void> {
    const r = this.request();
    if (!r || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const scopes = r.offered.filter((s) => this.chosen().has(s));
      const body = approve
        ? {
            approve,
            scopes,
            ...(scopes.includes('secrets') ? { secretTargets: this.targets() } : {}),
          }
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
