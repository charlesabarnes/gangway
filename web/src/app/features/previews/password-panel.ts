import { Component, computed, inject, input, signal } from '@angular/core';
import type { PasswordChoice, PasswordLogin, PasswordMode, Preview } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import type { ProblemError } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ToastService } from '../../ui/toast';
import { PreviewsStore } from './previews.store';

/** What each stored mode means, in the words the page shows. */
export const PASSWORD_LABELS: Record<PasswordMode, string> = {
  inherit: 'the server default',
  none: 'none: open to anyone with the link',
  set: 'its own password',
  generated: 'a generated password (in the log)',
};

export const LOGIN_LABELS: Record<PasswordLogin, string> = {
  inherit: 'as the server default says',
  on: 'skip the password',
  off: 'need the password too',
};

type Choice = PasswordChoice['mode'];

/**
 * ADR-0023: a running preview's password. Changing it takes effect on the next request and
 * signs out everyone who entered the old one. A generated password is printed ONLY in the
 * preview's log below; this panel never shows it.
 */
@Component({
  selector: 'app-password-panel',
  imports: [Btn],
  template: `
    <h2 class="mt-10 text-sm font-medium text-neutral-500">Password</h2>
    <div class="mt-2 rounded-lg border border-neutral-200 px-4 py-3 text-sm dark:border-neutral-800" data-testid="password-panel">
      <p data-testid="password-current">Now: <span class="font-medium">{{ label() }}</span></p>
      <p class="mt-1 text-neutral-600 dark:text-neutral-400" data-testid="password-effect">{{ effect() }}</p>
      @if (canChange()) {
        <label class="mt-3 block max-w-sm text-xs text-neutral-500">Should people signed in to gangway skip it?
          <select [class]="field" [disabled]="busy()" (change)="saveLogin($any($event.target).value)" data-testid="login-choice">
            @for (l of logins; track l) { <option [value]="l" [selected]="l === preview().passwordLogin">{{ loginOptions[l] }}</option> }
          </select>
        </label>
        <form class="mt-3 flex flex-wrap items-end gap-3" (submit)="$event.preventDefault(); save()">
          <label class="text-xs text-neutral-500">Change to
            <select [class]="field" [value]="choice()" (change)="choice.set($any($event.target).value)" data-testid="password-choice">
              <option value="set">a password I choose</option>
              <option value="generate">a new generated password</option>
              <option value="inherit">the server default</option>
              <option value="none">none: open it</option>
            </select>
          </label>
          @if (choice() === 'set') {
            <label class="min-w-48 flex-1 text-xs text-neutral-500">Password
              <input [class]="field" type="password" autocomplete="new-password" placeholder="any length" [value]="value()" (input)="value.set($any($event.target).value)" data-testid="password-input" />
            </label>
          }
          <button appBtn type="submit" [disabled]="busy() || (choice() === 'set' && value() === '')" data-testid="password-save">{{ busy() ? 'Saving…' : 'Save' }}</button>
        </form>
        @if (choice() === 'generate') {
          <p class="mt-2 text-xs text-neutral-500">The new password appears once, in the log below. Anyone who entered the old one has to enter the new one.</p>
        }
      }
    </div>
  `,
})
export class PasswordPanel {
  readonly preview = input.required<Preview>();

  readonly #store = inject(PreviewsStore);
  readonly #auth = inject(AuthService);
  readonly #toasts = inject(ToastService);

  protected readonly field = 'mt-1 block w-full rounded-md border border-neutral-300 bg-transparent px-2.5 py-1.5 text-sm dark:border-neutral-700';
  protected readonly choice = signal<Choice>('set');
  protected readonly value = signal('');
  protected readonly busy = signal(false);

  protected readonly label = computed(() => PASSWORD_LABELS[this.preview().password ?? 'inherit']);
  /** What actually happens to a visitor, with `inherit` already resolved by the server. */
  protected readonly effect = computed(() => {
    const p = this.preview();
    if (!p.passwordActive) {
      return p.password === 'inherit' ? 'Open to anyone with the link: the server default has no password right now.' : 'Open to anyone with the link.';
    }
    return p.signedInSkipsPassword
      ? 'Visitors are asked for the password. People signed in to gangway go straight in, so you will not see the form. Open it in a private window to see what visitors see.'
      : 'Everyone is asked for the password, including people signed in to gangway.';
  });
  protected readonly logins: PasswordLogin[] = ['inherit', 'on', 'off'];
  protected readonly loginOptions: Record<PasswordLogin, string> = {
    inherit: 'follow the server default', on: 'skip the password (personal use)', off: 'need the password too (sharing)',
  };
  /** The server decides whose preview is whose; either permission may be enough. */
  protected readonly canChange = computed(() => this.#auth.can('previews.update') || this.#auth.can('previews.update_own'));

  protected async save(): Promise<void> {
    const mode = this.choice();
    const choice: PasswordChoice = mode === 'set' ? { mode, value: this.value() } : { mode };
    this.busy.set(true);
    try {
      await this.#store.setPassword(this.preview().id, { password: choice });
      this.value.set('');
      this.#toasts.info('Password updated', mode === 'generate' ? 'The new password is in the log.' : PASSWORD_LABELS[mode === 'set' ? 'set' : mode]);
    } catch (e) {
      this.#toasts.problem('Could not change the password', e as ProblemError);
    } finally {
      this.busy.set(false);
    }
  }

  protected async saveLogin(login: PasswordLogin): Promise<void> {
    if (login === this.preview().passwordLogin) return;
    this.busy.set(true);
    try {
      await this.#store.setPassword(this.preview().id, { login });
      this.#toasts.info('Saved', `People signed in to gangway: ${LOGIN_LABELS[login]}`);
    } catch (e) {
      this.#toasts.problem('Could not change who skips the password', e as ProblemError);
    } finally {
      this.busy.set(false);
    }
  }
}
