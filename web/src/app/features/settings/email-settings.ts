import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, model, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { SettingView } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { issuesOrDetail, toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { FIELD } from '../../ui/field';
import { ToastService } from '../../ui/toast';

const URL_KEY = 'mail.smtp.url';
const FROM_KEY = 'mail.from';

/** The SMTP relay gangway sends invitations and password-reset links through. */
@Component({
  selector: 'app-email-settings',
  imports: [Btn],
  host: { class: 'block' },
  template: `
    <div class="gw-section" data-testid="email-settings">
      <div class="flex flex-col gap-1">
        <h2 class="gw-h2">Email</h2>
        <p class="gw-section-note">
          gangway emails invitations and password-reset links through an SMTP relay: Postmark,
          Resend, Amazon SES, Mailgun or your own. Without one, you set passwords and hand them
          over.
        </p>
      </div>
      <p class="flex items-center gap-2 text-[15px]" data-testid="email-status">
        <span
          class="size-[9px] shrink-0"
          [class]="configured() ? 'bg-ok' : 'bg-rule'"
          aria-hidden="true"
        ></span>
        @if (configured()) {
          Sending as <span class="font-mono text-sm">{{ savedFrom() }}</span>
        } @else if (urlSet()) {
          Add a From address to start sending.
        } @else {
          Not set up
        }
      </p>
      <form class="flex flex-col gap-5" (submit)="$event.preventDefault(); save()">
        <div class="grid gap-6 sm:grid-cols-2">
          <label class="gw-label block"
            >SMTP URL
            <input
              [class]="field"
              name="smtp-url"
              type="password"
              autocomplete="off"
              spellcheck="false"
              [placeholder]="urlSet() ? 'Saved; type a new one to replace it' : placeholder"
              [value]="url()"
              (input)="url.set($any($event.target).value)"
              [disabled]="!canWrite() || managed(url$) || saving() !== null"
              data-testid="smtp-url"
            />
            <span class="mt-1 block text-xs font-normal tracking-normal text-muted normal-case">
              smtp:// upgrades with STARTTLS on 587; smtps:// is TLS on 465; https:// posts each
              message as JSON, with the password as a bearer token.
              @if (managed(url$)) {
                Managed by config.
              }
            </span>
          </label>
          <label class="gw-label block"
            >From
            <input
              [class]="field"
              name="mail-from"
              type="text"
              autocomplete="off"
              placeholder="gangway <noreply@example.com>"
              [value]="from()"
              (input)="from.set($any($event.target).value)"
              [disabled]="!canWrite() || managed(from$) || saving() !== null"
              data-testid="mail-from"
            />
            <span class="mt-1 block text-xs font-normal tracking-normal text-muted normal-case">
              An address the relay may send as, on a domain with SPF and DKIM set up.
              @if (managed(from$)) {
                Managed by config.
              }
            </span>
          </label>
        </div>
        @if (canWrite()) {
          <div class="flex flex-wrap items-center gap-3">
            <button
              appBtn
              type="submit"
              [disabled]="saving() !== null || !dirty()"
              data-testid="save-email"
            >
              {{ saving() === url$ ? 'Saving…' : 'Save' }}
            </button>
            @if (urlSet() && !managed(url$)) {
              <button
                appBtn
                variant="ghost"
                type="button"
                [disabled]="saving() !== null"
                (click)="remove()"
                data-testid="remove-email"
              >
                Stop sending email
              </button>
            }
          </div>
        }
      </form>
      @if (canWrite() && configured()) {
        <form
          class="flex flex-wrap items-end gap-4"
          (submit)="$event.preventDefault(); test()"
          data-testid="email-test"
        >
          <label class="gw-label min-w-72 flex-1"
            >Send a test email to
            <input
              [class]="field"
              name="test-to"
              type="email"
              [value]="testTo()"
              (input)="testTo.set($any($event.target).value)"
              data-testid="test-to"
          /></label>
          <button
            appBtn
            variant="ghost"
            type="submit"
            [disabled]="testing() || !testTo().includes('@')"
            data-testid="send-test"
          >
            {{ testing() ? 'Sending…' : 'Send test' }}
          </button>
        </form>
        @if (testError(); as e) {
          <p class="text-sm text-danger" role="alert" data-testid="test-error">{{ e }}</p>
        }
      }
    </div>
  `,
})
export class EmailSettings {
  readonly settings = input.required<SettingView[]>();
  readonly saving = model.required<string | null>();

  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);
  readonly #auth = inject(AuthService);

  protected readonly field = FIELD;
  protected readonly url$ = URL_KEY;
  protected readonly from$ = FROM_KEY;
  protected readonly placeholder = 'smtp://user:password@smtp.example.com:587';
  protected readonly canWrite = computed(() => this.#auth.can('settings.write'));
  readonly #row = (key: string) => this.settings().find((s) => s.key === key);
  protected readonly managed = (key: string) => this.#row(key)?.managedByConfig === true;

  // The URL holds a password, so the server only says whether one is saved.
  protected readonly urlSet = linkedSignal(() => this.#row(URL_KEY)?.set === true);
  protected readonly savedFrom = linkedSignal(() => String(this.#row(FROM_KEY)?.value ?? ''));
  protected readonly url = signal('');
  protected readonly from = linkedSignal(() => this.savedFrom());
  protected readonly configured = computed(() => this.urlSet() && this.savedFrom() !== '');
  protected readonly dirty = computed(
    () => this.url().trim() !== '' || this.from().trim() !== this.savedFrom(),
  );

  protected readonly testTo = linkedSignal(() => this.#auth.user()?.email ?? '');
  protected readonly testing = signal(false);
  protected readonly testError = signal<string | null>(null);

  protected async save(): Promise<void> {
    const values: Record<string, string> = {};
    if (this.url().trim() !== '') values[URL_KEY] = this.url().trim();
    if (this.from().trim() !== this.savedFrom()) values[FROM_KEY] = this.from().trim();
    if (!(await this.#put(values, 'Could not save the email settings'))) return;
    if (values[URL_KEY] !== undefined) this.urlSet.set(true);
    if (values[FROM_KEY] !== undefined) this.savedFrom.set(values[FROM_KEY]);
    this.url.set('');
    this.#toasts.info(
      this.configured() ? 'Email settings saved. Send a test to check them.' : 'Saved',
    );
  }

  protected async remove(): Promise<void> {
    if (!(await this.#put({ [URL_KEY]: '' }, 'Could not remove the SMTP URL'))) return;
    this.urlSet.set(false);
    this.#toasts.info('gangway no longer sends email');
  }

  protected async test(): Promise<void> {
    if (this.testing()) return;
    this.testing.set(true);
    this.testError.set(null);
    const to = this.testTo().trim();
    try {
      await firstValueFrom(this.#http.post('/v1/settings/mail/test', { to }));
      this.#toasts.info(`Test email sent to ${to}`, 'Check the inbox, and the spam folder.');
    } catch (e) {
      this.testError.set(issuesOrDetail(toProblem(e)));
    } finally {
      this.testing.set(false);
    }
  }

  async #put(values: Record<string, string>, failure: string): Promise<boolean> {
    if (this.saving() !== null) return false;
    this.saving.set(URL_KEY);
    try {
      await firstValueFrom(this.#http.put('/v1/settings', { values }));
      return true;
    } catch (e) {
      this.#toasts.problem(failure, toProblem(e));
      return false;
    } finally {
      this.saving.set(null);
    }
  }
}
