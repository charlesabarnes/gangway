import { HttpClient } from '@angular/common/http';
import { Component, inject, signal, viewChild } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  SCOPES,
  SCOPE_PERMISSIONS,
  type ApiToken,
  type OAuthGrant,
  type Permission,
  type Scope,
} from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { Clock } from '../../core/clock';
import { issuesOrDetail, toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ClipboardService } from '../../ui/clipboard';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { RelativeTimePipe } from '../../ui/relative-time.pipe';
import { ToastService } from '../../ui/toast';
import { ConnectAgent } from './connect-agent';
import { ConnectedAgents } from './connected-agents';
import { FIELD, LABEL } from './fields';

const SCOPE_HELP: Record<Scope, string> = {
  read: 'See previews, logs, events and hosts.',
  deploy:
    'Everything in read, plus deploy and destroy previews, and rebuild the ones you deployed. What CI needs.',
  update: 'Rebuild any preview in place, not only your own. Add it to deploy.',
  admin: 'Everything, including users, roles and settings.',
};
const EXPIRY = [
  { value: '', label: 'never' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '365d', label: '1 year' },
];

@Component({
  selector: 'app-api-tokens',
  host: { class: 'block' },
  imports: [Btn, ConfirmDialog, ConnectAgent, ConnectedAgents, RelativeTimePipe],
  template: `
    <h2 class="mt-10 text-base font-semibold">API tokens</h2>
    <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
      For scripts and CI. A token can never do more than you can: tighten your role and your tokens
      tighten with it.
    </p>

    @if (minted(); as m) {
      <div
        class="mt-4 rounded-lg border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/30"
        role="status"
        data-testid="minted"
      >
        <p class="text-sm font-medium text-emerald-900 dark:text-emerald-200">
          Token “{{ m.name }}” created. Copy it now — it will not be shown again.
        </p>
        <div class="mt-2 flex items-center gap-2">
          <code
            class="min-w-0 flex-1 rounded bg-white px-2.5 py-1.5 font-mono text-xs break-all select-all dark:bg-neutral-900"
            data-testid="secret"
            >{{ m.secret }}</code
          >
          <button
            appBtn
            variant="ghost"
            type="button"
            (click)="copy(m.secret)"
            data-testid="copy-secret"
          >
            Copy
          </button>
          <button
            appBtn
            variant="ghost"
            type="button"
            (click)="minted.set(null)"
            data-testid="done"
          >
            Done
          </button>
        </div>
      </div>
    }

    <form
      (submit)="create($event)"
      novalidate
      class="mt-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
      data-testid="token-form"
    >
      <div class="grid gap-4 sm:grid-cols-3">
        <div class="sm:col-span-2">
          <label for="tname" [class]="label">Name</label
          ><input
            id="tname"
            [class]="field"
            placeholder="github-actions"
            [value]="name()"
            (input)="name.set($any($event.target).value)"
            data-testid="token-name"
          />
        </div>
        <div>
          <label for="texp" [class]="label">Expires</label>
          <select
            id="texp"
            [class]="field"
            [value]="expiresIn()"
            (change)="expiresIn.set($any($event.target).value)"
            data-testid="token-expiry"
          >
            @for (o of expiry; track o.value) {
              <option [value]="o.value">{{ o.label }}</option>
            }
          </select>
        </div>
      </div>
      <fieldset class="mt-4">
        <legend [class]="label">Scopes</legend>
        <div class="mt-2 space-y-2">
          @for (s of scopes; track s) {
            <label class="flex items-start gap-2.5 text-sm" [class.opacity-50]="!covers(s)">
              <input
                type="checkbox"
                class="mt-0.5"
                [checked]="chosen().has(s)"
                [disabled]="!covers(s)"
                (change)="toggle(s)"
                [attr.data-testid]="'scope-' + s"
              />
              <span
                ><span class="font-mono text-xs font-medium">{{ s }}</span> — {{ help[s] }}
                @if (!covers(s)) {
                  <span class="text-neutral-500"> Your role does not cover this.</span>
                }
              </span>
            </label>
          }
        </div>
      </fieldset>
      <div class="mt-4 flex items-center gap-3">
        <button
          appBtn
          type="submit"
          [disabled]="busy() || name().trim() === '' || chosen().size === 0"
          data-testid="create-token"
        >
          Create token
        </button>
        @if (error(); as e) {
          <span
            class="text-sm text-red-700 dark:text-red-400"
            role="alert"
            data-testid="token-error"
            >{{ e }}</span
          >
        }
      </div>
    </form>

    <ul
      class="mt-4 divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800"
      data-testid="tokens"
    >
      @for (t of tokens(); track t.id) {
        <li
          class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm"
          [class.opacity-50]="t.revokedAt"
          data-testid="token"
        >
          <span class="font-medium">{{ t.name }}</span>
          <code class="font-mono text-xs text-neutral-500">{{ t.prefix }}…</code>
          <span class="text-xs text-neutral-500">{{ t.scopes.join(', ') }}</span>
          <span class="ml-auto text-xs text-neutral-500">
            @if (t.revokedAt) {
              revoked {{ t.revokedAt | relativeTime: clock.now() }}
            } @else {
              {{
                t.lastUsedAt ? 'used ' + (t.lastUsedAt | relativeTime: clock.now()) : 'never used'
              }}
              ·
              {{
                t.expiresAt ? 'expires ' + (t.expiresAt | relativeTime: clock.now()) : 'no expiry'
              }}
            }
          </span>
          @if (!t.revokedAt) {
            <button
              type="button"
              (click)="askRevoke(t)"
              class="text-neutral-500 hover:text-red-600 dark:hover:text-red-400"
              data-testid="revoke"
            >
              Revoke
            </button>
          }
        </li>
      } @empty {
        <li class="px-4 py-6 text-center text-sm text-neutral-500" data-testid="no-tokens">
          No tokens yet.
        </li>
      }
    </ul>

    <app-confirm-dialog
      [heading]="'Revoke ' + (pending()?.name ?? '') + '?'"
      confirmLabel="Revoke"
      (confirmed)="revoke()"
    >
      Anything using this token stops working immediately. It cannot be un-revoked; create a new one
      instead.
    </app-confirm-dialog>

    <app-connect-agent />

    <app-connected-agents [(grants)]="grants" />
  `,
})
export class ApiTokens {
  readonly #auth = inject(AuthService);
  protected readonly clock = inject(Clock);
  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);
  readonly #clipboard = inject(ClipboardService);
  private readonly dialog = viewChild.required(ConfirmDialog);

  protected readonly field = FIELD;
  protected readonly label = LABEL;
  protected readonly scopes = SCOPES;
  protected readonly help = SCOPE_HELP;
  protected readonly expiry = EXPIRY;

  protected readonly tokens = signal<ApiToken[]>([]);
  protected readonly grants = signal<OAuthGrant[]>([]);
  protected readonly name = signal('');
  protected readonly expiresIn = signal('90d');
  protected readonly chosen = signal<ReadonlySet<Scope>>(new Set());
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly minted = signal<{ name: string; secret: string } | null>(null);
  protected readonly pending = signal<ApiToken | null>(null);

  constructor() {
    void this.#load();
  }

  async #load(): Promise<void> {
    try {
      const [{ tokens }, { grants }] = await Promise.all([
        firstValueFrom(this.#http.get<{ tokens: ApiToken[] }>('/v1/tokens')),
        firstValueFrom(this.#http.get<{ grants: OAuthGrant[] }>('/v1/oauth/grants')),
      ]);
      this.tokens.set(tokens);
      this.grants.set(grants);
    } catch (e) {
      this.error.set(toProblem(e).detail);
    }
  }

  protected covers(scope: Scope): boolean {
    return SCOPE_PERMISSIONS[scope].every((p: Permission) => this.#auth.can(p));
  }

  protected toggle(scope: Scope): void {
    const next = new Set(this.chosen());
    if (!next.delete(scope)) next.add(scope);
    this.chosen.set(next);
  }

  protected async create(e: Event): Promise<void> {
    e.preventDefault();
    if (this.busy() || this.name().trim() === '' || this.chosen().size === 0) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const body = {
        name: this.name().trim(),
        scopes: SCOPES.filter((s) => this.chosen().has(s)),
        ...(this.expiresIn() ? { expiresIn: this.expiresIn() } : {}),
      };
      const made = await firstValueFrom(
        this.#http.post<{ token: ApiToken; secret: string }>('/v1/tokens', body),
      );
      this.minted.set({ name: made.token.name, secret: made.secret });
      this.tokens.update((ts) => [made.token, ...ts]);
      this.name.set('');
      this.chosen.set(new Set());
    } catch (err) {
      const p = toProblem(err);
      this.error.set(issuesOrDetail(p));
      if (p.status === 422 || p.status === 403) void this.#auth.refresh();
    } finally {
      this.busy.set(false);
    }
  }

  protected askRevoke(t: ApiToken): void {
    this.pending.set(t);
    this.dialog().open();
  }

  protected async revoke(): Promise<void> {
    const t = this.pending();
    if (!t) return;
    try {
      const { token } = await firstValueFrom(
        this.#http.delete<{ token: ApiToken }>(`/v1/tokens/${t.id}`),
      );
      this.tokens.update((ts) => ts.map((x) => (x.id === token.id ? token : x)));
    } catch (err) {
      this.#toasts.problem(`Could not revoke ${t.name}`, toProblem(err));
    }
  }

  protected copy(secret: string): Promise<void> {
    return this.#clipboard.copy(
      secret,
      ['Copied'],
      ['Could not copy', 'Select the token and copy it by hand.'],
    );
  }
}
