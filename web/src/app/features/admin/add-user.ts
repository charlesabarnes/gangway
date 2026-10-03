import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, output, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { User } from '../../core/admin.types';
import { issuesOrDetail, toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { FIELD } from '../../ui/field';
import { ToastService } from '../../ui/toast';

// No 0/O or 1/l/I, so a password read aloud or copied by hand survives.
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generatePassword(length = 20): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** A new account, and its first password to hand over, or null when it was invited by email. */
export type Added = { user: User; password: string | null };

/** How a new account gets in. */
export type How = 'sso' | 'invite' | 'password';

/**
 * Adds an account: through the identity provider, an emailed invitation, or a first password
 * the admin hands over.
 */
@Component({
  selector: 'app-add-user',
  imports: [Btn],
  host: { class: 'block' },
  template: `
    <div class="gw-section">
      <div class="flex flex-col gap-1">
        <h2 class="gw-h2">Add a user</h2>
        <p class="gw-section-note">
          @if (sso(); as label) {
            They sign in with “{{ label }}” using this email address.
            @if (!localLogin()) {
              Password sign-in is off on this server.
            }
          } @else if (mail()) {
            Email them an invitation to choose a password, or set a first password and hand it over.
          } @else {
            You set a first password and hand it over. To email invitations instead, set up email
            under Admin → Server.
          }
          The role decides what they may do, and you can change it at any time.
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
              @for (r of roles(); track r.id) {
                <option [value]="r.id" [selected]="r.id === roleId()">{{ r.name }}</option>
              }
            </select></label
          >
        </div>
        @if (choices().length > 1) {
          <fieldset class="flex flex-wrap gap-x-6 gap-y-2" data-testid="invite-choice">
            <legend class="sr-only">How they get in</legend>
            @for (c of choices(); track c.how) {
              <label class="flex items-center gap-2.5 text-[15px]">
                <input
                  type="radio"
                  name="how"
                  [checked]="how() === c.how"
                  (change)="pick.set(c.how)"
                  [attr.data-testid]="'how-' + c.how"
                />
                {{ c.label }}
              </label>
            }
          </fieldset>
        }
        <div class="flex items-end gap-3" [hidden]="how() !== 'password'">
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
            @if (how() === 'invite') {
              {{ busy() ? 'Sending…' : 'Send invitation' }}
            } @else {
              {{ busy() ? 'Adding…' : 'Add user' }}
            }
          </button>
          @if (how() === 'password' && password().length > 0 && password().length < 12) {
            <span class="text-sm text-muted">At least 12 characters.</span>
          }
          @if (error(); as e) {
            <span class="text-sm text-danger" role="alert" data-testid="user-error">{{ e }}</span>
          }
        </div>
      </form>
    </div>
  `,
})
export class AddUser {
  readonly roles = input.required<readonly { id: string; name: string }[]>();
  readonly defaultRole = input.required<string>();
  /** The server can send email, so an account can be an invitation instead of a password. */
  readonly mail = input.required<boolean>();
  /** The identity provider's button text, when one is set up. */
  readonly sso = input<string | null>(null);
  /** Password sign-in is on; off leaves only the identity provider. */
  readonly localLogin = input(true);
  readonly added = output<Added>();

  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);

  protected readonly field = FIELD;
  protected readonly generate = generatePassword;

  protected readonly email = signal('');
  protected readonly password = signal(generatePassword());
  protected readonly roleId = linkedSignal(() => this.defaultRole());
  protected readonly choices = computed(() => {
    const out: { how: How; label: string }[] = [];
    const label = this.sso();
    if (label !== null) out.push({ how: 'sso', label: `Signs in with “${label}”` });
    if (this.mail())
      out.push({
        how: 'invite',
        label: this.localLogin()
          ? 'Email an invitation'
          : 'The same, and email them where to sign in',
      });
    if (this.localLogin()) out.push({ how: 'password', label: 'Set a first password' });
    return out;
  });
  protected readonly pick = signal<How | null>(null);
  protected readonly how = computed<How>(() => {
    const options = this.choices().map((c) => c.how);
    const picked = this.pick();
    return picked !== null && options.includes(picked) ? picked : (options[0] ?? 'password');
  });
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly ready = computed(
    () =>
      this.email().trim().includes('@') &&
      (this.how() !== 'password' || this.password().length >= 12) &&
      this.roleId() !== '',
  );

  protected async create(e: Event): Promise<void> {
    e.preventDefault();
    if (!this.ready() || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    const password = this.password();
    const how = this.how();
    const inviting = how === 'invite';
    try {
      const { user, invite } = await firstValueFrom(
        this.#http.post<{ user: User; invite?: { sent: boolean; error?: string } }>('/v1/users', {
          email: this.email().trim(),
          roleId: this.roleId(),
          ...(how === 'sso' ? { sso: true } : inviting ? { invite: true } : { password }),
        }),
      );
      this.added.emit({ user, password: how === 'password' ? password : null });
      if (how === 'sso') this.#toasts.info(`Added ${user.email}`);
      if (inviting && invite?.sent) this.#toasts.info(`Invitation sent to ${user.email}`);
      else if (inviting)
        this.error.set(
          `Added ${user.email}, but the invitation was not sent: ${invite?.error ?? 'unknown error'}. ` +
            'Resend it from the list once email works.',
        );
      this.email.set('');
      this.password.set(generatePassword());
    } catch (err) {
      this.error.set(issuesOrDetail(toProblem(err)));
    } finally {
      this.busy.set(false);
    }
  }
}
