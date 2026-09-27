import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { RolesResponse, User } from '../../core/admin.types';
import { AuthService } from '../../core/auth.service';
import { Clock } from '../../core/clock';
import { issuesOrDetail, toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ClipboardService } from '../../ui/clipboard';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { FIELD } from '../../ui/field';
import { RelativeTimePipe } from '../../ui/relative-time.pipe';
import { Skeleton } from '../../ui/skeleton';
import { ToastService } from '../../ui/toast';

// No 0/O or 1/l/I, so a password read aloud or copied by hand survives.
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generatePassword(length = 20): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

type Pending = { kind: 'disable' | 'reset'; user: User };

/** Every account: add one, change its role, disable it, or give it a new password. */
@Component({
  selector: 'app-users-list',
  imports: [Btn, ConfirmDialog, RelativeTimePipe, Skeleton],
  host: { class: 'flex flex-col gap-7' },
  template: `
    @if (handoff(); as h) {
      <div
        class="flex flex-col gap-2.5 bg-flag/20 p-4 shadow-[inset_3px_0_0_var(--gw-flag)]"
        role="status"
        data-testid="handoff"
      >
        <p class="text-[15px] font-medium">
          {{ h.created ? 'Account created for' : 'New password for' }} {{ h.email }}. Give them this
          password — it will not be shown again. They can change it under Account.
        </p>
        <div class="flex flex-wrap items-center gap-2.5">
          <code
            class="min-w-0 flex-1 bg-surface px-2.5 py-2 font-mono text-xs break-all select-all"
            data-testid="handoff-password"
            >{{ h.password }}</code
          >
          <button
            appBtn
            variant="ghost"
            size="sm"
            type="button"
            (click)="copy(h.password)"
            data-testid="copy-password"
          >
            Copy
          </button>
          <button
            appBtn
            variant="ghost"
            size="sm"
            type="button"
            (click)="handoff.set(null)"
            data-testid="handoff-done"
          >
            Done
          </button>
        </div>
      </div>
    }

    @if (canManage()) {
      <div class="gw-section">
        <div class="flex flex-col gap-1">
          <h2 class="gw-h2">Add a user</h2>
          <p class="gw-section-note">
            There are no invitations: you set a first password and hand it over. The role decides
            what they may do, and you can change it at any time.
          </p>
        </div>
        <form
          (submit)="create($event)"
          novalidate
          class="flex flex-col gap-[18px]"
          data-testid="user-form"
        >
          <div class="grid gap-6 sm:grid-cols-2">
            <label class="gw-label block"
              >Email
              <input
                [class]="field"
                type="email"
                autocomplete="off"
                placeholder="ada@example.com"
                [value]="email()"
                (input)="email.set($any($event.target).value)"
                data-testid="new-email"
            /></label>
            <label class="gw-label block"
              >Role
              <select
                [class]="field"
                [value]="roleId()"
                (change)="roleId.set($any($event.target).value)"
                data-testid="new-role"
              >
                @for (r of roleOptions(); track r.id) {
                  <option [value]="r.id" [selected]="r.id === roleId()">{{ r.name }}</option>
                }
              </select></label
            >
          </div>
          <div class="flex items-end gap-3">
            <label class="gw-label block min-w-0 flex-1"
              >First password
              <input
                [class]="field + ' font-mono'"
                type="text"
                autocomplete="new-password"
                spellcheck="false"
                [value]="password()"
                (input)="password.set($any($event.target).value)"
                data-testid="new-password"
            /></label>
            <button
              appBtn
              variant="ghost"
              size="sm"
              type="button"
              (click)="password.set(generate())"
              data-testid="generate"
            >
              Generate
            </button>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <button appBtn type="submit" [disabled]="!ready() || busy()" data-testid="create-user">
              {{ busy() ? 'Adding…' : 'Add user' }}
            </button>
            @if (password().length > 0 && password().length < 12) {
              <span class="text-sm text-muted">At least 12 characters.</span>
            }
            @if (error(); as e) {
              <span class="text-sm text-danger" role="alert" data-testid="user-error">{{ e }}</span>
            }
          </div>
        </form>
      </div>
    }

    <div class="flex flex-col gap-3">
      <h2 class="gw-h2">Users</h2>
      @if (loading()) {
        <app-skeleton kind="rows" [count]="3" />
      } @else {
        <div class="overflow-x-auto">
          <table class="w-full border-t border-ink text-sm" data-testid="users">
            <thead>
              <tr class="border-b border-ink text-left">
                <th class="gw-label py-2 pr-4 font-semibold">Email</th>
                <th class="gw-label py-2 pr-4 font-semibold">Role</th>
                <th class="gw-label py-2 pr-4 font-semibold">Status</th>
                <th class="gw-label py-2 pr-4 font-semibold">Added</th>
                @if (canManage()) {
                  <th class="py-2"><span class="sr-only">Actions</span></th>
                }
              </tr>
            </thead>
            <tbody>
              @for (u of users(); track u.id) {
                <tr
                  class="border-b border-rule"
                  [class.opacity-60]="u.disabled"
                  data-testid="user-row"
                >
                  <td class="py-2.5 pr-4 text-[15px] break-all">
                    {{ u.email }}
                    @if (u.id === me()) {
                      <span class="gw-tag ml-1.5" data-testid="you">you</span>
                    }
                  </td>
                  <td class="py-2.5 pr-4">
                    @if (canManage()) {
                      <select
                        class="border-0 border-b border-rule bg-transparent py-1 text-sm text-ink focus:outline-none focus-visible:shadow-[0_2px_0_var(--gw-flag)] [&>option]:bg-paper"
                        [attr.aria-label]="'Role for ' + u.email"
                        [disabled]="rowBusy() === u.id"
                        (change)="changeRole(u, $any($event.target))"
                        data-testid="user-role"
                      >
                        @for (r of roleOptions(); track r.id) {
                          <option [value]="r.id" [selected]="r.id === u.roleId">
                            {{ r.name }}
                          </option>
                        }
                      </select>
                    } @else {
                      <span data-testid="user-role">{{ roleName(u.roleId) }}</span>
                    }
                  </td>
                  <td class="py-2.5 pr-4" data-testid="user-status">
                    {{ u.disabled ? 'Disabled' : 'Active' }}
                  </td>
                  <td class="py-2.5 pr-4 whitespace-nowrap text-muted">
                    {{ u.createdAt | relativeTime: clock.now() }}
                  </td>
                  @if (canManage()) {
                    <td class="py-2.5 text-right whitespace-nowrap">
                      <button
                        type="button"
                        class="gw-action"
                        [disabled]="rowBusy() === u.id"
                        (click)="ask('reset', u)"
                        data-testid="reset-password"
                      >
                        Reset password
                      </button>
                      @if (u.id !== me()) {
                        @if (u.disabled) {
                          <button
                            type="button"
                            class="gw-action ml-4"
                            [disabled]="rowBusy() === u.id"
                            (click)="setDisabled(u, false)"
                            data-testid="enable"
                          >
                            Enable
                          </button>
                        } @else {
                          <button
                            type="button"
                            class="gw-action ml-4 hover:!text-danger"
                            [disabled]="rowBusy() === u.id"
                            (click)="ask('disable', u)"
                            data-testid="disable"
                          >
                            Disable
                          </button>
                        }
                      }
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>

    <app-confirm-dialog
      [heading]="
        (pending()?.kind === 'disable' ? 'Disable ' : 'Reset the password for ') +
        (pending()?.user?.email ?? '') +
        '?'
      "
      [confirmLabel]="pending()?.kind === 'disable' ? 'Disable' : 'Reset password'"
      (confirmed)="confirm()"
    >
      @if (pending()?.kind === 'disable') {
        They are logged out everywhere, and their connected agents are disconnected. You can enable
        the account again later.
      } @else {
        A new password is generated for you to hand over. They are logged out everywhere, and their
        connected agents are disconnected.
      }
    </app-confirm-dialog>
  `,
})
export class UsersList {
  readonly #http = inject(HttpClient);
  readonly #auth = inject(AuthService);
  readonly #toasts = inject(ToastService);
  readonly #clipboard = inject(ClipboardService);
  protected readonly clock = inject(Clock);
  private readonly dialog = viewChild.required(ConfirmDialog);

  protected readonly field = FIELD;
  protected readonly generate = generatePassword;

  protected readonly users = signal<User[]>([]);
  readonly #roles = signal<RolesResponse['roles']>([]);
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly rowBusy = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly pending = signal<Pending | null>(null);
  protected readonly handoff = signal<{
    email: string;
    password: string;
    created: boolean;
  } | null>(null);

  protected readonly email = signal('');
  protected readonly password = signal(generatePassword());
  protected readonly roleId = signal('');

  protected readonly canManage = computed(() => this.#auth.can('users.manage'));
  protected readonly me = computed(() => this.#auth.user()?.id ?? null);
  // Without roles.read there are no role names; fall back to the ids users already hold.
  protected readonly roleOptions = computed(() => {
    const roles = this.#roles();
    if (roles.length > 0) return roles.map((r) => ({ id: r.id, name: r.name }));
    return [...new Set(this.users().map((u) => u.roleId))].map((id) => ({ id, name: id }));
  });
  protected readonly ready = computed(
    () => this.email().trim().includes('@') && this.password().length >= 12 && this.roleId() !== '',
  );

  constructor() {
    void this.#load();
  }

  async #load(): Promise<void> {
    try {
      const [{ users }, roles] = await Promise.all([
        firstValueFrom(this.#http.get<{ users: User[] }>('/v1/users')),
        this.#auth.can('roles.read')
          ? firstValueFrom(this.#http.get<RolesResponse>('/v1/roles')).then((r) => r.roles)
          : Promise.resolve([]),
      ]);
      this.users.set(users);
      this.#roles.set(roles);
      // Default to a role the matrix can narrow, so a new account is never everything by accident.
      this.roleId.set(roles.find((r) => r.editable)?.id ?? this.roleOptions()[0]?.id ?? '');
    } catch (e) {
      this.#toasts.problem('Could not load users', toProblem(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected roleName(id: string): string {
    return this.roleOptions().find((r) => r.id === id)?.name ?? id;
  }

  protected async create(e: Event): Promise<void> {
    e.preventDefault();
    if (!this.ready() || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    const password = this.password();
    try {
      const { user } = await firstValueFrom(
        this.#http.post<{ user: User }>('/v1/users', {
          email: this.email().trim(),
          password,
          roleId: this.roleId(),
        }),
      );
      this.users.update((us) => [...us, user]);
      this.handoff.set({ email: user.email, password, created: true });
      this.email.set('');
      this.password.set(generatePassword());
    } catch (err) {
      this.error.set(issuesOrDetail(toProblem(err)));
    } finally {
      this.busy.set(false);
    }
  }

  protected async changeRole(u: User, select: HTMLSelectElement): Promise<void> {
    const roleId = select.value;
    if (roleId === u.roleId) return;
    const saved = await this.#patch(u, { roleId }, `Could not change the role of ${u.email}`);
    // The select holds the new value even when the server refused it.
    if (!saved) select.value = u.roleId;
    else if (u.id === this.me()) void this.#auth.refresh();
  }

  protected setDisabled(u: User, disabled: boolean): Promise<User | null> {
    return this.#patch(u, { disabled }, `Could not ${disabled ? 'disable' : 'enable'} ${u.email}`);
  }

  protected ask(kind: Pending['kind'], user: User): void {
    this.pending.set({ kind, user });
    this.dialog().open();
  }

  protected async confirm(): Promise<void> {
    const p = this.pending();
    if (!p) return;
    if (p.kind === 'disable') {
      await this.setDisabled(p.user, true);
      return;
    }
    const password = generatePassword();
    const saved = await this.#patch(
      p.user,
      { password },
      `Could not reset the password for ${p.user.email}`,
    );
    if (saved) this.handoff.set({ email: saved.email, password, created: false });
  }

  async #patch(
    u: User,
    body: { roleId?: string; disabled?: boolean; password?: string },
    failure: string,
  ): Promise<User | null> {
    this.rowBusy.set(u.id);
    try {
      const { user } = await firstValueFrom(
        this.#http.patch<{ user: User }>(`/v1/users/${u.id}`, body),
      );
      this.users.update((us) => us.map((x) => (x.id === user.id ? user : x)));
      return user;
    } catch (err) {
      this.#toasts.problem(failure, toProblem(err));
      return null;
    } finally {
      this.rowBusy.set(null);
    }
  }

  protected copy(password: string): Promise<void> {
    return this.#clipboard.copy(
      password,
      ['Copied'],
      ['Could not copy', 'Select the password and copy it by hand.'],
    );
  }
}
