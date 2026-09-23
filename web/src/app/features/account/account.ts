import { HttpClient } from '@angular/common/http';
import { Component, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
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
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { ConnectAgent } from './connect-agent';
import { RelativeTimePipe } from '../../ui/relative-time.pipe';
import { ToastService } from '../../ui/toast';

const FIELD =
  'mt-1.5 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm placeholder:text-neutral-400 focus:border-accent focus:outline-2 focus:outline-accent/30 dark:border-neutral-700 dark:bg-neutral-900';
const LABEL = 'block text-sm font-medium text-neutral-800 dark:text-neutral-200';
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

/**
 * Who you are, what your role lets you do, your password, and your API tokens. Not one of
 * §10.3's eight screens on its own -- it stands in for "Tokens" until Phase 5 -- and it
 * is deliberately small.
 */
@Component({
  selector: 'app-account',
  imports: [Btn, ConfirmDialog, ConnectAgent, RelativeTimePipe],
  template: `
    <section class="mx-auto max-w-3xl px-6 py-10">
      <h1 class="text-2xl font-semibold tracking-tight">Account</h1>

      @if (auth.user(); as user) {
        <div
          class="mt-6 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
          data-testid="identity"
        >
          <p class="font-medium">{{ user.email }}</p>
          <p class="mt-0.5 text-sm text-neutral-500">
            Role: <span class="text-neutral-800 dark:text-neutral-200">{{ user.role.name }}</span>
          </p>
          <p class="mt-4 text-xs text-neutral-500">
            What this role may do. An admin can change it, and changes apply at once — no need to
            log in again.
          </p>
          <dl class="mt-2 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2" data-testid="permissions">
            @for (g of grouped(); track g.feature) {
              <div class="flex gap-2">
                <dt class="w-20 shrink-0 text-neutral-500">{{ g.feature }}</dt>
                <dd>{{ g.verbs.join(', ') }}</dd>
              </div>
            } @empty {
              <p class="text-neutral-500">Nothing. Ask an admin.</p>
            }
          </dl>
        </div>
      }

      <h2 class="mt-10 text-base font-semibold">Password</h2>
      <form
        (submit)="changePassword($event)"
        novalidate
        class="mt-3 grid gap-4 sm:grid-cols-3"
        data-testid="password-form"
      >
        <div>
          <label for="current" [class]="label">Current</label
          ><input
            id="current"
            type="password"
            autocomplete="current-password"
            [class]="field"
            [value]="current()"
            (input)="current.set($any($event.target).value)"
            data-testid="current"
          />
        </div>
        <div>
          <label for="next" [class]="label">New</label
          ><input
            id="next"
            type="password"
            autocomplete="new-password"
            [class]="field"
            [value]="next()"
            (input)="next.set($any($event.target).value)"
            data-testid="next"
          />
        </div>
        <div>
          <label for="again" [class]="label">New, again</label
          ><input
            id="again"
            type="password"
            autocomplete="new-password"
            [class]="field"
            [value]="again()"
            (input)="again.set($any($event.target).value)"
            data-testid="again"
          />
        </div>
        <div class="flex items-center gap-3 sm:col-span-3">
          <button
            appBtn
            variant="ghost"
            type="submit"
            [disabled]="pwBusy() || !pwReady()"
            data-testid="change-password"
          >
            Change password
          </button>
          <span class="text-xs text-neutral-500"
            >At least 12 characters. Your other sessions will be logged out.</span
          >
        </div>
        @if (pwError(); as e) {
          <p
            class="text-sm text-red-700 sm:col-span-3 dark:text-red-400"
            role="alert"
            data-testid="pw-error"
          >
            {{ e }}
          </p>
        }
      </form>

      @if (canTokens()) {
        <h2 class="mt-10 text-base font-semibold">API tokens</h2>
        <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          For scripts and CI. A token can never do more than you can: tighten your role and your
          tokens tighten with it.
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
          #tokenDialog
          [heading]="'Revoke ' + (pending()?.name ?? '') + '?'"
          confirmLabel="Revoke"
          (confirmed)="revoke()"
        >
          Anything using this token stops working immediately. It cannot be un-revoked; create a new
          one instead.
        </app-confirm-dialog>

        <app-connect-agent />

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
                  g.lastUsedAt
                    ? 'used ' + (g.lastUsedAt | relativeTime: clock.now())
                    : 'not used yet'
                }}</span
              >
              <button
                type="button"
                (click)="askDisconnect(g)"
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
          #grantDialog
          [heading]="'Disconnect ' + (disconnecting()?.clientName ?? '') + '?'"
          confirmLabel="Disconnect"
          (confirmed)="disconnect()"
        >
          It loses access at once. To use it again, connect it again from its side.
        </app-confirm-dialog>
      }
    </section>
  `,
})
export class Account {
  protected readonly auth = inject(AuthService);
  protected readonly clock = inject(Clock);
  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);
  // Two dialogs on this page: each by its own template ref.
  private readonly tokenDialog = viewChild<ConfirmDialog>('tokenDialog');
  private readonly grantDialog = viewChild<ConfirmDialog>('grantDialog');

  protected readonly field = FIELD;
  protected readonly label = LABEL;
  protected readonly scopes = SCOPES;
  protected readonly help = SCOPE_HELP;
  protected readonly expiry = EXPIRY;

  protected readonly canTokens = computed(() => this.auth.can('tokens.manage_own'));
  protected readonly grouped = computed(() => {
    const by = new Map<string, string[]>();
    for (const p of [...this.auth.permissions()].sort()) {
      const [feature = '', verb = ''] = p.split('.');
      by.set(feature, [...(by.get(feature) ?? []), verb.replace(/_/g, ' ')]);
    }
    return [...by].map(([feature, verbs]) => ({ feature, verbs }));
  });

  protected readonly tokens = signal<ApiToken[]>([]);
  protected readonly name = signal('');
  protected readonly expiresIn = signal('90d');
  protected readonly chosen = signal<ReadonlySet<Scope>>(new Set());
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Held in memory for as long as this page is open and not a moment longer. */
  protected readonly minted = signal<{ name: string; secret: string } | null>(null);
  protected readonly pending = signal<ApiToken | null>(null);
  protected readonly grants = signal<OAuthGrant[]>([]);
  protected readonly disconnecting = signal<OAuthGrant | null>(null);

  protected readonly current = signal('');
  protected readonly next = signal('');
  protected readonly again = signal('');
  protected readonly pwBusy = signal(false);
  protected readonly pwError = signal<string | null>(null);
  protected readonly pwReady = computed(
    () => this.current() !== '' && this.next().length >= 12 && this.next() === this.again(),
  );

  constructor() {
    // An effect, not a one-off check: the permission can be granted (or taken) while this
    // page is open, and the section appearing with an empty list would be a lie.
    effect(() => {
      if (this.canTokens()) untracked(() => void this.#load());
    });
  }

  protected covers(scope: Scope): boolean {
    return SCOPE_PERMISSIONS[scope].every((p: Permission) => this.auth.can(p));
  }

  protected toggle(scope: Scope): void {
    const next = new Set(this.chosen());
    if (!next.delete(scope)) next.add(scope);
    this.chosen.set(next);
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

  protected hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  protected askDisconnect(g: OAuthGrant): void {
    this.disconnecting.set(g);
    this.grantDialog()?.open();
  }

  protected async disconnect(): Promise<void> {
    const g = this.disconnecting();
    if (!g) return;
    try {
      await firstValueFrom(this.#http.delete(`/v1/oauth/grants/${g.id}`));
      this.grants.update((gs) => gs.filter((x) => x.id !== g.id));
    } catch (err) {
      this.#toasts.problem(`Could not disconnect ${g.clientName}`, toProblem(err));
    }
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
      this.error.set(
        p.issues.length ? p.issues.map((i) => `${i.path}: ${i.message}`).join('; ') : p.detail,
      );
      // 422 "your role does not cover…": the role changed under this tab. Learn the new truth.
      if (p.status === 422 || p.status === 403) void this.auth.refresh();
    } finally {
      this.busy.set(false);
    }
  }

  protected askRevoke(t: ApiToken): void {
    this.pending.set(t);
    this.tokenDialog()?.open();
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

  protected async copy(secret: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(secret);
      this.#toasts.info('Copied');
    } catch {
      this.#toasts.info('Could not copy', 'Select the token and copy it by hand.');
    }
  }

  protected async changePassword(e: Event): Promise<void> {
    e.preventDefault();
    if (this.pwBusy() || !this.pwReady()) return;
    this.pwBusy.set(true);
    this.pwError.set(null);
    try {
      await firstValueFrom(
        this.#http.post('/v1/auth/password', { current: this.current(), next: this.next() }),
      );
      this.current.set('');
      this.next.set('');
      this.again.set('');
      this.#toasts.info('Password changed', 'Your other sessions were logged out.');
    } catch (err) {
      const p = toProblem(err);
      this.pwError.set(
        p.status === 403
          ? 'The current password is wrong.'
          : p.status === 429
            ? `Too many attempts. Try again in ${p.retryAfter ?? 60} s.`
            : p.detail,
      );
    } finally {
      this.pwBusy.set(false);
    }
  }
}
