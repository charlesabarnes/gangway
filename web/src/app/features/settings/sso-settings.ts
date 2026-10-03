import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, model, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { SettingView } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { FIELD } from '../../ui/field';
import { ToastService } from '../../ui/toast';

const ISSUER = 'auth.oidc.issuer';
const CLIENT_ID = 'auth.oidc.clientId';
const SECRET = 'auth.oidc.clientSecret';
const LABEL = 'auth.oidc.label';
const PASSWORDS = 'auth.passwords';

/** Sign-in through an OpenID Connect provider, and whether passwords still work beside it. */
@Component({
  selector: 'app-sso-settings',
  imports: [Btn],
  host: { class: 'block' },
  template: `
    <div class="gw-section" data-testid="sso-settings">
      <div class="flex flex-col gap-1">
        <h2 class="gw-h2">Single sign-on</h2>
        <p class="gw-section-note">
          People sign in through an OpenID Connect provider: Authentik, Keycloak, Google Workspace
          or another. Only accounts you add under Admin → Users get in; the provider proves who they
          are. Register this redirect URI with the provider:
          <span class="font-mono text-sm break-all" data-testid="redirect-uri">{{ redirect }}</span>
        </p>
      </div>
      <p class="flex items-center gap-2 text-[15px]" data-testid="sso-status">
        <span
          class="size-[9px] shrink-0"
          [class]="configured() ? 'bg-ok' : 'bg-rule'"
          aria-hidden="true"
        ></span>
        {{ configured() ? 'On' : 'Not set up' }}
      </p>
      <form class="flex flex-col gap-5" (submit)="$event.preventDefault(); save()">
        <div class="grid gap-6 sm:grid-cols-2">
          <label class="gw-label block"
            >Issuer
            <input
              [class]="field"
              type="url"
              autocomplete="off"
              spellcheck="false"
              placeholder="https://auth.example.com/application/o/gangway/"
              [value]="issuer()"
              (input)="issuer.set($any($event.target).value)"
              [disabled]="!canWrite() || managed(keys.issuer) || saving() !== null"
              data-testid="oidc-issuer"
          /></label>
          <label class="gw-label block"
            >Button text
            <input
              [class]="field"
              type="text"
              autocomplete="off"
              [value]="label()"
              (input)="label.set($any($event.target).value)"
              [disabled]="!canWrite() || managed(keys.label) || saving() !== null"
              data-testid="oidc-label"
          /></label>
          <label class="gw-label block"
            >Client ID
            <input
              [class]="field"
              type="text"
              autocomplete="off"
              spellcheck="false"
              [value]="clientId()"
              (input)="clientId.set($any($event.target).value)"
              [disabled]="!canWrite() || managed(keys.clientId) || saving() !== null"
              data-testid="oidc-client-id"
          /></label>
          <label class="gw-label block"
            >Client secret
            <input
              [class]="field"
              type="password"
              autocomplete="off"
              [placeholder]="secretSet() ? 'Saved; type a new one to replace it' : ''"
              [value]="secret()"
              (input)="secret.set($any($event.target).value)"
              [disabled]="!canWrite() || managed(keys.secret) || saving() !== null"
              data-testid="oidc-secret"
          /></label>
        </div>
        <label class="flex items-center gap-2.5 text-[15px]">
          <input
            type="checkbox"
            [checked]="passwords()"
            (change)="passwords.set($any($event.target).checked)"
            [disabled]="
              !canWrite() || managed(keys.passwords) || saving() !== null || !configured()
            "
            data-testid="sso-passwords"
          />
          Also allow sign-in with a password
        </label>
        @if (canWrite()) {
          <div class="flex flex-wrap items-center gap-3">
            <button
              appBtn
              type="submit"
              [disabled]="saving() !== null || !dirty()"
              data-testid="save-sso"
            >
              {{ saving() === keys.issuer ? 'Saving…' : 'Save' }}
            </button>
          </div>
        }
      </form>
    </div>
  `,
})
export class SsoSettings {
  readonly settings = input.required<SettingView[]>();
  readonly saving = model.required<string | null>();

  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);
  readonly #auth = inject(AuthService);

  protected readonly field = FIELD;
  protected readonly keys = {
    issuer: ISSUER,
    clientId: CLIENT_ID,
    secret: SECRET,
    label: LABEL,
    passwords: PASSWORDS,
  };
  protected readonly redirect = `${location.origin}/v1/auth/oidc/callback`;
  protected readonly canWrite = computed(() => this.#auth.can('settings.write'));
  // What the server holds: the input at first, then each save's answer.
  readonly #view = linkedSignal(() => this.settings());
  readonly #row = (key: string) => this.#view().find((s) => s.key === key);
  protected readonly managed = (key: string) => this.#row(key)?.managedByConfig === true;
  readonly #saved = (key: string) => String(this.#row(key)?.value ?? '');

  protected readonly issuer = linkedSignal(() => this.#saved(ISSUER));
  protected readonly clientId = linkedSignal(() => this.#saved(CLIENT_ID));
  protected readonly label = linkedSignal(() => this.#saved(LABEL));
  protected readonly passwords = linkedSignal(() => this.#row(PASSWORDS)?.value !== false);
  // The secret is never sent back, only whether one is saved.
  protected readonly secretSet = linkedSignal(() => this.#row(SECRET)?.set === true);
  protected readonly secret = signal('');

  protected readonly configured = computed(
    () =>
      this.#saved(ISSUER) !== '' &&
      this.#saved(CLIENT_ID) !== '' &&
      (this.secretSet() || this.secret().trim() !== ''),
  );
  protected readonly dirty = computed(
    () =>
      this.issuer().trim() !== this.#saved(ISSUER) ||
      this.clientId().trim() !== this.#saved(CLIENT_ID) ||
      this.label().trim() !== this.#saved(LABEL) ||
      this.secret().trim() !== '' ||
      this.passwords() !== (this.#row(PASSWORDS)?.value !== false),
  );

  protected async save(): Promise<void> {
    if (this.saving() !== null) return;
    const values: Record<string, string | boolean> = {};
    const put = (key: string, now: string) => {
      if (!this.managed(key) && now !== this.#saved(key)) values[key] = now;
    };
    put(ISSUER, this.issuer().trim());
    put(CLIENT_ID, this.clientId().trim());
    put(LABEL, this.label().trim());
    if (this.secret().trim() !== '') values[SECRET] = this.secret().trim();
    if (!this.managed(PASSWORDS) && this.passwords() !== (this.#row(PASSWORDS)?.value !== false))
      values[PASSWORDS] = this.passwords();
    this.saving.set(ISSUER);
    try {
      const { settings } = await firstValueFrom(
        this.#http.put<{ settings: SettingView[] }>('/v1/settings', { values }),
      );
      this.#view.set(settings);
      this.secret.set('');
      this.#toasts.info('Single sign-on saved');
    } catch (e) {
      this.#toasts.problem('Could not save single sign-on', toProblem(e));
    } finally {
      this.saving.set(null);
    }
  }
}
