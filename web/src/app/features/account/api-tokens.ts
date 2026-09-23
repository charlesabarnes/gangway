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
  host: { class: 'contents' },
  imports: [Btn, ConfirmDialog, ConnectAgent, ConnectedAgents, RelativeTimePipe],
  template: `
    <div class="gw-section">
      <div class="flex flex-col gap-1">
        <h2 class="gw-h2">API tokens</h2>
        <p class="gw-section-note">
          For scripts and CI. A token can never do more than you can: tighten your role and your
          tokens tighten with it.
        </p>
      </div>
      <div class="flex min-w-0 flex-col gap-[18px]">
        @if (minted(); as m) {
          <div
            class="flex flex-col gap-2.5 bg-flag/20 p-4 shadow-[inset_3px_0_0_var(--gw-flag)]"
            role="status"
            data-testid="minted"
          >
            <p class="text-[15px] font-medium">
              Token “{{ m.name }}” created. Copy it now — it will not be shown again.
            </p>
            <div class="flex flex-wrap items-center gap-2.5">
              <code
                class="min-w-0 flex-1 bg-surface px-2.5 py-2 font-mono text-xs break-all select-all"
                data-testid="secret"
                >{{ m.secret }}</code
              >
              <button
                appBtn
                variant="ghost"
                size="sm"
                type="button"
                (click)="copy(m.secret)"
                data-testid="copy-secret"
              >
                Copy
              </button>
              <button
                appBtn
                variant="ghost"
                size="sm"
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
          class="flex flex-col gap-[18px]"
          data-testid="token-form"
        >
          <div class="grid gap-6 sm:grid-cols-3">
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
          <fieldset>
            <legend [class]="label">Scopes</legend>
            <div class="mt-2 flex flex-col gap-2">
              @for (s of scopes; track s) {
                <label
                  class="flex items-start gap-2.5 text-sm leading-snug"
                  [class.opacity-50]="!covers(s)"
                >
                  <input
                    type="checkbox"
                    class="gw-box mt-[3px]"
                    [checked]="chosen().has(s)"
                    [disabled]="!covers(s)"
                    (change)="toggle(s)"
                    [attr.data-testid]="'scope-' + s"
                  />
                  <span
                    ><code class="font-mono text-xs font-medium">{{ s }}</code> — {{ help[s] }}
                    @if (!covers(s)) {
                      <span class="text-muted"> Your role does not cover this.</span>
                    }
                  </span>
                </label>
              }
            </div>
          </fieldset>
          <div class="flex flex-wrap items-center gap-3">
            <button
              appBtn
              type="submit"
              [disabled]="busy() || name().trim() === '' || chosen().size === 0"
              data-testid="create-token"
            >
              Create token
            </button>
            @if (error(); as e) {
              <span class="text-sm text-danger" role="alert" data-testid="token-error">{{
                e
              }}</span>
            }
          </div>
        </form>

        <ul class="border-t border-ink" data-testid="tokens">
          @for (t of tokens(); track t.id) {
            <li
              class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule py-2.5 text-sm"
              [class.opacity-50]="t.revokedAt"
              data-testid="token"
            >
              <span class="text-[15px] font-medium">{{ t.name }}</span>
              <code class="font-mono text-xs text-muted">{{ t.prefix }}…</code>
              <span class="text-[13px] text-muted">{{ t.scopes.join(', ') }}</span>
              <span class="ml-auto text-[13px] text-muted">
                @if (t.revokedAt) {
                  revoked {{ t.revokedAt | relativeTime: clock.now() }}
                } @else {
                  {{
                    t.lastUsedAt
                      ? 'used ' + (t.lastUsedAt | relativeTime: clock.now())
                      : 'never used'
                  }}
                  ·
                  {{
                    t.expiresAt
                      ? 'expires ' + (t.expiresAt | relativeTime: clock.now())
                      : 'no expiry'
                  }}
                }
              </span>
              @if (!t.revokedAt) {
                <button
                  type="button"
                  (click)="askRevoke(t)"
                  class="gw-action hover:!text-danger"
                  data-testid="revoke"
                >
                  Revoke
                </button>
              }
            </li>
          } @empty {
            <li class="border-b border-rule py-2.5 text-sm text-muted" data-testid="no-tokens">
              No tokens yet.
            </li>
          }
        </ul>
      </div>
    </div>

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
