import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, model, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { DefaultPasswordMode, SettingView } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { FIELD } from '../../ui/field';
import { ToastService } from '../../ui/toast';

const SAVED_DETAIL: Record<DefaultPasswordMode, string> = {
  off: 'Previews that follow the default are open.',
  shared: 'Previews that follow the default ask for the shared password.',
  generated: 'New previews get their own password, in their log.',
};

function passwordFrom(settings: SettingView[]) {
  const mode = settings.find((s) => s.key === 'previews.password.mode');
  const shared = settings.find((s) => s.key === 'previews.password.shared');
  const login = settings.find((s) => s.key === 'previews.password.login');
  return {
    mode: (mode?.value as DefaultPasswordMode | undefined) ?? 'off',
    set: shared?.set ?? false,
    login: login?.value === true,
    managed: !!(mode?.managedByConfig || shared?.managedByConfig || login?.managedByConfig),
  };
}

@Component({
  selector: 'app-preview-passwords',
  host: { class: 'block' },
  imports: [Btn],
  template: `
    <div class="gw-section">
      <div class="flex flex-col gap-1">
        <h2 class="gw-h2">Preview passwords</h2>
        <p class="gw-section-note">
          What a preview that follows the server default asks visitors for. A preview can still
          choose its own password, or none, when it is made or later on its page.
        </p>
      </div>
      <form
        class="flex flex-col gap-3.5"
        data-testid="preview-password"
        (submit)="$event.preventDefault(); save()"
      >
        <div class="grid gap-6 sm:grid-cols-2">
          <label class="flex flex-col gap-1"
            ><span class="gw-label">Default</span>
            <select
              [class]="field"
              [disabled]="!canWrite() || saved().managed || saving() === 'password'"
              (change)="draft.set($any($event.target).value)"
              data-testid="password-default"
            >
              <option value="off" [selected]="draft() === 'off'">off: previews are open</option>
              <option value="shared" [selected]="draft() === 'shared'">one shared password</option>
              <option value="generated" [selected]="draft() === 'generated'">
                generate one per new preview
              </option>
            </select>
          </label>
          @if (draft() === 'shared') {
            <label class="flex flex-col gap-1"
              ><span class="gw-label">{{
                saved().set
                  ? 'New shared password (blank keeps the current one)'
                  : 'Shared password'
              }}</span>
              <input
                [class]="field"
                type="password"
                autocomplete="new-password"
                placeholder="any length"
                [disabled]="!canWrite() || saved().managed"
                [value]="value()"
                (input)="value.set($any($event.target).value)"
                data-testid="password-shared"
              />
            </label>
          }
        </div>
        <label class="flex items-center gap-2 text-[15px]">
          <input
            type="checkbox"
            class="gw-box"
            [checked]="loginDraft()"
            [disabled]="!canWrite() || saved().managed"
            (change)="loginDraft.set($any($event.target).checked)"
            data-testid="password-login"
          />
          People signed in to gangway can use their login instead of the password
        </label>
        <p class="-mt-2 text-xs text-muted">
          The default for every preview with a password, its own or the shared one. Off: everyone is
          asked, you included. Each preview can still choose under "Who can open it": the password,
          people signed in to gangway, or either.
        </p>
        <p class="text-[13px] leading-normal text-muted" data-testid="password-help">
          @switch (draft()) {
            @case ('shared') {
              Every preview that follows the default asks for this password. Changing it signs
              everyone out of those previews.
            }
            @case ('generated') {
              Each new preview gets its own password, printed once in its log. Previews that already
              exist are not changed.
            }
            @default {
              Previews that follow the default are open to anyone with the link.
            }
          }
          @if (saved().managed) {
            <span class="block">managed by config</span>
          }
        </p>
        @if (canWrite() && !saved().managed) {
          <button
            appBtn
            type="submit"
            class="self-start"
            [disabled]="saving() !== null || unchanged()"
            data-testid="password-save"
          >
            {{ saving() === 'password' ? 'Saving…' : 'Save' }}
          </button>
        }
      </form>
    </div>
  `,
})
export class PreviewPasswords {
  readonly settings = input.required<SettingView[]>();
  readonly saving = model.required<string | null>();

  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);
  readonly #auth = inject(AuthService);
  protected readonly canWrite = computed(() => this.#auth.can('settings.write'));

  protected readonly field = FIELD;
  protected readonly saved = linkedSignal(() => passwordFrom(this.settings()));
  protected readonly draft = linkedSignal(() => this.saved().mode);
  protected readonly loginDraft = linkedSignal(() => this.saved().login);
  protected readonly value = signal('');
  protected readonly unchanged = computed(() => {
    const s = this.saved();
    if (this.draft() === 'shared' && !s.set && this.value() === '') return true;
    return this.draft() === s.mode && this.value() === '' && this.loginDraft() === s.login;
  });

  protected async save(): Promise<void> {
    if (this.saving() !== null) return;
    const mode = this.draft();
    const value = this.value();
    this.saving.set('password');
    try {
      const { settings } = await firstValueFrom(
        this.#http.put<{ settings: SettingView[] }>('/v1/settings/preview-password', {
          mode,
          login: this.loginDraft(),
          ...(mode === 'shared' && value !== '' ? { value } : {}),
        }),
      );
      this.saved.set(passwordFrom(settings));
      this.value.set('');
      this.#toasts.info('Preview passwords saved', SAVED_DETAIL[mode]);
    } catch (e) {
      this.#toasts.problem('Could not save preview passwords', toProblem(e));
    } finally {
      this.saving.set(null);
    }
  }
}
