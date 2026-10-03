import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { RolesResponse, User } from '../../core/admin.types';
import { AuthService } from '../../core/auth.service';
import { Clock } from '../../core/clock';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ClipboardService } from '../../ui/clipboard';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { RelativeTimePipe } from '../../ui/relative-time.pipe';
import { Skeleton } from '../../ui/skeleton';
import { ToastService } from '../../ui/toast';
import { AddUser, generatePassword, type Added } from './add-user';

type Pending = { kind: 'disable' | 'reset'; user: User };

/** Every account: add one, change its role, disable it, or give it a new password. */
@Component({
  selector: 'app-users-list',
  imports: [AddUser, Btn, ConfirmDialog, RelativeTimePipe, Skeleton],
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
      <app-add-user
        [roles]="roleOptions()"
        [defaultRole]="defaultRole()"
        [mail]="mail()"
        [sso]="sso()"
        [localLogin]="localLogin()"
        (added)="added($event)"
      />
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
                    {{ u.disabled ? 'Disabled' : u.invited ? 'Invited' : 'Active' }}
                  </td>
                  <td class="py-2.5 pr-4 whitespace-nowrap text-muted">
                    {{ u.createdAt | relativeTime: clock.now() }}
                  </td>
                  @if (canManage()) {
                    <td class="py-2.5 text-right whitespace-nowrap">
                      @if (mail() && !u.disabled) {
                        <button
                          type="button"
                          class="gw-action mr-4"
                          [disabled]="rowBusy() === u.id"
                          (click)="emailLink(u)"
                          data-testid="email-link"
                        >
                          {{
                            !localLogin()
                              ? 'Email where to sign in'
                              : u.invited
                                ? 'Resend invitation'
                                : 'Email a reset link'
                          }}
                        </button>
                      }
                      @if (localLogin()) {
                        <button
                          type="button"
                          class="gw-action"
                          [disabled]="rowBusy() === u.id"
                          (click)="ask('reset', u)"
                          data-testid="reset-password"
                        >
                          {{ u.invited ? 'Set a password' : 'Reset password' }}
                        </button>
                      }
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

  protected readonly users = signal<User[]>([]);
  readonly #roles = signal<RolesResponse['roles']>([]);
  protected readonly loading = signal(true);
  protected readonly rowBusy = signal<string | null>(null);
  protected readonly pending = signal<Pending | null>(null);
  protected readonly handoff = signal<{
    email: string;
    password: string;
    created: boolean;
  } | null>(null);

  /** The server can send email, so an account can be an invitation instead of a password. */
  protected readonly mail = signal(false);
  /** The identity provider's button text, when one is set up. */
  protected readonly sso = signal<string | null>(null);
  /** Password sign-in is on; off leaves only the identity provider. */
  protected readonly localLogin = signal(true);
  protected readonly defaultRole = signal('');

  protected readonly canManage = computed(() => this.#auth.can('users.manage'));
  protected readonly me = computed(() => this.#auth.user()?.id ?? null);
  // Without roles.read there are no role names; fall back to the ids users already hold.
  protected readonly roleOptions = computed(() => {
    const roles = this.#roles();
    if (roles.length > 0) return roles.map((r) => ({ id: r.id, name: r.name }));
    return [...new Set(this.users().map((u) => u.roleId))].map((id) => ({ id, name: id }));
  });

  constructor() {
    void this.#load(); // NOSONAR the load starts with the component; moving it to ngOnInit changes its timing
  }

  async #load(): Promise<void> {
    try {
      const [{ users, email, sso, localLogin }, roles] = await Promise.all([
        firstValueFrom(
          this.#http.get<{
            users: User[];
            email?: boolean;
            sso?: { label: string } | null;
            localLogin?: boolean;
          }>('/v1/users'),
        ),
        this.#auth.can('roles.read')
          ? firstValueFrom(this.#http.get<RolesResponse>('/v1/roles')).then((r) => r.roles)
          : Promise.resolve([]),
      ]);
      this.users.set(users);
      this.mail.set(email === true);
      this.sso.set(sso?.label ?? null);
      this.localLogin.set(localLogin !== false);
      this.#roles.set(roles);
      // Default to a role the matrix can narrow, so a new account is never everything by accident.
      this.defaultRole.set(roles.find((r) => r.editable)?.id ?? this.roleOptions()[0]?.id ?? '');
    } catch (e) {
      this.#toasts.problem('Could not load users', toProblem(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected roleName(id: string): string {
    return this.roleOptions().find((r) => r.id === id)?.name ?? id;
  }

  protected added({ user, password }: Added): void {
    this.users.update((us) => [...us, user]);
    if (password !== null) this.handoff.set({ email: user.email, password, created: true });
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

  protected async emailLink(u: User): Promise<void> {
    this.rowBusy.set(u.id);
    try {
      const { sent } = await firstValueFrom(
        this.#http.post<{ sent: 'invite' | 'reset' | 'sso' }>(`/v1/users/${u.id}/email-link`, {}),
      );
      this.#toasts.info(
        sent === 'invite'
          ? `Invitation sent to ${u.email}`
          : sent === 'sso'
            ? `Sign-in details sent to ${u.email}`
            : `Reset link sent to ${u.email}`,
      );
    } catch (err) {
      this.#toasts.problem(`Could not email ${u.email}`, toProblem(err));
    } finally {
      this.rowBusy.set(null);
    }
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
