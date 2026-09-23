import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import type {
  PasswordChange,
  PasswordChoice,
  PasswordLogin,
  Preview,
  PreviewAccess,
} from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import type { ProblemError } from '../../core/problem';
import { Btn } from '../../ui/button';
import { FIELD } from '../../ui/field';
import { ToastService } from '../../ui/toast';
import { PreviewsStore } from './previews.store';

export type Who = 'open' | 'password' | 'signed-in' | 'either';
export const WHO_LABELS: Record<Who, string> = {
  open: 'Anyone with the link',
  password: 'Anyone with the password',
  'signed-in': 'People signed in to gangway',
  either: 'People signed in to gangway, or anyone with the password',
};
const WHO_LOGIN: Record<Who, PasswordLogin> = {
  open: 'off',
  password: 'off',
  'signed-in': 'only',
  either: 'on',
};

type Source = 'keep' | 'generate' | 'set' | 'shared';

export const ACCESS_EFFECT: Record<PreviewAccess, string> = {
  open: 'Anyone with the link can open it.',
  password: 'Everyone is asked for the password, including people signed in to gangway.',
  'signed-in': 'Only people signed in to gangway can open it. Anyone else is sent to log in.',
  either:
    'People signed in to gangway go straight in; anyone else is asked for the password. Open it in a private window to see what visitors see.',
  'signed-in+password': 'A private preview: sign in to gangway, then enter the password.',
};

@Component({
  selector: 'app-password-panel',
  imports: [Btn],
  host: { class: 'flex flex-col gap-2.5' },
  template: `
    <h2 class="gw-label">Who can open it</h2>
    <div class="gw-neatline px-5 py-4 text-[15px]" data-testid="password-panel">
      <p data-testid="password-effect">{{ effect() }}</p>
      @if (canChange()) {
        <form
          class="mt-4 flex flex-wrap items-end gap-6"
          (submit)="$event.preventDefault(); save()"
        >
          <label class="gw-label min-w-64"
            >Who can open it
            <select [class]="field" (change)="who.set($any($event.target).value)" data-testid="who">
              @for (w of whos; track w) {
                <option [value]="w" [selected]="w === who()">{{ whoLabels[w] }}</option>
              }
            </select>
          </label>
          @if (needsPassword()) {
            <label class="gw-label"
              >Password
              <select
                [class]="field"
                (change)="source.set($any($event.target).value)"
                data-testid="password-source"
              >
                @if (hasOwn()) {
                  <option value="keep" [selected]="source() === 'keep'">
                    keep the current one
                  </option>
                }
                <option value="generate" [selected]="source() === 'generate'">
                  generate a new one (shown in the log)
                </option>
                <option value="set" [selected]="source() === 'set'">choose one…</option>
                <option value="shared" [selected]="source() === 'shared'">
                  the server's shared password
                </option>
              </select>
            </label>
            @if (source() === 'set') {
              <label class="gw-label min-w-48 flex-1"
                >New password
                <input
                  [class]="field"
                  type="password"
                  autocomplete="new-password"
                  placeholder="any length"
                  [value]="value()"
                  (input)="value.set($any($event.target).value)"
                  data-testid="password-input"
                />
              </label>
            }
          }
          <button
            appBtn
            type="submit"
            [disabled]="
              busy() || !changed() || (needsPassword() && source() === 'set' && value() === '')
            "
            data-testid="password-save"
          >
            {{ busy() ? 'Saving…' : 'Save' }}
          </button>
        </form>
        @if (needsPassword() && source() === 'generate') {
          <p class="mt-2 text-xs text-muted">
            The new password appears once, in the log below. Anyone who entered the old one has to
            enter the new one.
          </p>
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

  protected readonly field = `${FIELD} mt-1 font-normal tracking-normal normal-case`;
  protected readonly whos: Who[] = ['open', 'password', 'signed-in', 'either'];
  protected readonly whoLabels = WHO_LABELS;

  protected readonly who = signal<Who>('open');
  protected readonly source = signal<Source>('generate');
  protected readonly value = signal('');
  protected readonly busy = signal(false);

  protected readonly hasOwn = computed(() =>
    ['set', 'generated'].includes(this.preview().password),
  );
  protected readonly needsPassword = computed(
    () => this.who() === 'password' || this.who() === 'either',
  );
  protected readonly effect = computed(() => ACCESS_EFFECT[this.preview().access ?? 'open']);
  protected readonly canChange = computed(
    () => this.#auth.can('previews.update') || this.#auth.can('previews.update_own'),
  );
  protected readonly changed = computed(
    () =>
      this.who() !== whoOf(this.preview().access) ||
      (this.needsPassword() && this.source() !== 'keep'),
  );

  constructor() {
    effect(() => {
      const p = this.preview();
      untracked(() => {
        this.who.set(whoOf(p.access));
        this.source.set(
          ['set', 'generated'].includes(p.password)
            ? 'keep'
            : p.password === 'inherit' && (p.access === 'password' || p.access === 'either')
              ? 'shared'
              : 'generate',
        );
      });
    });
  }

  protected async save(): Promise<void> {
    const who = this.who();
    const change: PasswordChange = { login: WHO_LOGIN[who] };
    if (who === 'open') change.password = { mode: 'none' };
    else if (this.needsPassword()) {
      const src = this.source();
      const choice: PasswordChoice | undefined =
        src === 'generate'
          ? { mode: 'generate' }
          : src === 'set'
            ? { mode: 'set', value: this.value() }
            : src === 'shared'
              ? { mode: 'inherit' }
              : undefined;
      if (choice) change.password = choice;
    }
    this.busy.set(true);
    try {
      await this.#store.setPassword(this.preview().id, change);
      this.value.set('');
      this.#toasts.info(
        'Saved',
        change.password?.mode === 'generate'
          ? `${WHO_LABELS[who]}. The new password is in the log.`
          : WHO_LABELS[who],
      );
    } catch (e) {
      this.#toasts.problem('Could not change who can open it', e as ProblemError);
    } finally {
      this.busy.set(false);
    }
  }
}

function whoOf(access: PreviewAccess | undefined): Who {
  switch (access) {
    case 'password':
      return 'password';
    case 'either':
      return 'either';
    case 'signed-in':
    case 'signed-in+password':
      return 'signed-in';
    default:
      return 'open';
  }
}
