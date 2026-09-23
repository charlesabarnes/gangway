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
import { ToastService } from '../../ui/toast';
import { PreviewsStore } from './previews.store';

/** The choices, in the order they are offered. */
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

/** Where the password comes from, when the choice needs one. */
type Source = 'keep' | 'generate' | 'set' | 'shared';

/** What a visitor gets, in a sentence, for what the server says is in effect. */
export const ACCESS_EFFECT: Record<PreviewAccess, string> = {
  open: 'Anyone with the link can open it.',
  password: 'Everyone is asked for the password, including people signed in to gangway.',
  'signed-in': 'Only people signed in to gangway can open it. Anyone else is sent to log in.',
  either:
    'People signed in to gangway go straight in; anyone else is asked for the password. Open it in a private window to see what visitors see.',
  'signed-in+password': 'A private preview: sign in to gangway, then enter the password.',
};

/**
 * Who can open a running preview. One choice -- the link, the password, a gangway
 * login, or either -- and, when the choice needs a password, where it comes from. Takes
 * effect on the next request; a new password signs out everyone who used the old one. A
 * generated password is printed only in the preview's log below; this panel never shows it.
 */
@Component({
  selector: 'app-password-panel',
  imports: [Btn],
  template: `
    <h2 class="mt-10 text-sm font-medium text-neutral-500">Who can open it</h2>
    <div
      class="mt-2 rounded-lg border border-neutral-200 px-4 py-3 text-sm dark:border-neutral-800"
      data-testid="password-panel"
    >
      <p data-testid="password-effect">{{ effect() }}</p>
      @if (canChange()) {
        <form
          class="mt-3 flex flex-wrap items-end gap-3"
          (submit)="$event.preventDefault(); save()"
        >
          <label class="min-w-64 text-xs text-neutral-500"
            >Who can open it
            <select [class]="field" (change)="who.set($any($event.target).value)" data-testid="who">
              @for (w of whos; track w) {
                <option [value]="w" [selected]="w === who()">{{ whoLabels[w] }}</option>
              }
            </select>
          </label>
          @if (needsPassword()) {
            <label class="text-xs text-neutral-500"
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
              <label class="min-w-48 flex-1 text-xs text-neutral-500"
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
          <p class="mt-2 text-xs text-neutral-500">
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

  protected readonly field =
    'mt-1 block w-full rounded-md border border-neutral-300 bg-transparent px-2.5 py-1.5 text-sm dark:border-neutral-700';
  protected readonly whos: Who[] = ['open', 'password', 'signed-in', 'either'];
  protected readonly whoLabels = WHO_LABELS;

  protected readonly who = signal<Who>('open');
  protected readonly source = signal<Source>('generate');
  protected readonly value = signal('');
  protected readonly busy = signal(false);

  /** The preview's own password (set or generated), which "keep" keeps. */
  protected readonly hasOwn = computed(() =>
    ['set', 'generated'].includes(this.preview().password),
  );
  protected readonly needsPassword = computed(
    () => this.who() === 'password' || this.who() === 'either',
  );
  protected readonly effect = computed(() => ACCESS_EFFECT[this.preview().access ?? 'open']);
  /** The server decides whose preview is whose; either permission may be enough. */
  protected readonly canChange = computed(
    () => this.#auth.can('previews.update') || this.#auth.can('previews.update_own'),
  );
  protected readonly changed = computed(
    () =>
      this.who() !== whoOf(this.preview().access) ||
      (this.needsPassword() && this.source() !== 'keep'),
  );

  constructor() {
    // Follow the preview: after a save, or when it changes elsewhere, the form shows what is in effect.
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

/** The choice that produces what is in effect. A private preview reads as signed-in. */
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
