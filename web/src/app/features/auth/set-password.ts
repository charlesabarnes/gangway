import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { issuesOrDetail, toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ErrorAlert } from '../../ui/error-alert';
import { Skeleton } from '../../ui/skeleton';
import { AuthCard, FIELD, LABEL } from './auth-card';

const MIN_PASSWORD = 12;

type Link = { email: string; purpose: 'invite' | 'reset' };

/** Where an emailed invitation or reset link lands: choose a password, and you are logged in. */
@Component({
  selector: 'app-set-password',
  imports: [AuthCard, Btn, ErrorAlert, RouterLink, Skeleton],
  template: `
    <app-auth-card
      [heading]="link()?.purpose === 'invite' ? 'Welcome to gangway' : 'Choose a new password'"
    >
      <span lede>
        @if (link(); as l) {
          @if (l.purpose === 'invite') {
            Choose a password for <span class="font-mono">{{ l.email }}</span> to finish setting up
            your account.
          } @else {
            For <span class="font-mono">{{ l.email }}</span
            >. Choosing one logs you out everywhere else.
          }
        }
      </span>

      @if (gone()) {
        <div class="space-y-[18px]">
          <app-error-alert class="px-3 py-2.5" data-testid="gone">
            <p class="font-medium">This link has expired or was already used.</p>
            <p class="mt-1">
              Invitations last a week and reset links an hour, and each works once. Ask for a new
              one.
            </p>
          </app-error-alert>
          <a routerLink="/forgot-password" class="gw-action inline-block" data-testid="again"
            >Email me a new link</a
          >
        </div>
      } @else if (!link()) {
        <app-skeleton [count]="2" label="Checking the link" />
      } @else {
        <form (submit)="submit($event)" novalidate class="space-y-[18px]">
          @if (error(); as e) {
            <app-error-alert class="px-3 py-2.5" data-testid="error">{{ e }}</app-error-alert>
          }
          <input type="hidden" name="email" autocomplete="username" [value]="link()!.email" />
          <div>
            <label for="password" [class]="label">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autocomplete="new-password"
              required
              autofocus
              aria-describedby="pw-hint"
              [class]="field"
              [value]="password()"
              (input)="password.set($any($event.target).value)"
              data-testid="password"
            />
            <p
              id="pw-hint"
              class="mt-1.5 text-xs"
              [class]="tooShort() ? 'text-warn' : 'text-muted'"
            >
              At least {{ min }} characters. Length is the only rule — a few unrelated words works
              well.
            </p>
          </div>
          <div>
            <label for="confirm" [class]="label">Password, again</label>
            <input
              id="confirm"
              name="confirm"
              type="password"
              autocomplete="new-password"
              required
              [class]="field"
              [value]="confirm()"
              (input)="confirm.set($any($event.target).value)"
              data-testid="confirm"
            />
            @if (mismatch()) {
              <p class="mt-1.5 text-xs text-warn" data-testid="mismatch">These do not match yet.</p>
            }
          </div>
          <button
            appBtn
            type="submit"
            class="w-full !py-[13px] !text-sm !tracking-[.14em]"
            [disabled]="busy() || !ready()"
            data-testid="submit"
          >
            {{ busy() ? 'Saving…' : 'Save and log in' }}
          </button>
        </form>
      }
    </app-auth-card>
  `,
})
export class SetPassword {
  readonly #http = inject(HttpClient);
  readonly #auth = inject(AuthService);
  readonly #router = inject(Router);

  // The secret rides in the fragment, which never reaches a server log or a Referer header.
  readonly #token = location.hash.replace(/^#/, '');

  protected readonly min = MIN_PASSWORD;
  protected readonly field = FIELD;
  protected readonly label = LABEL;

  protected readonly link = signal<Link | null>(null);
  protected readonly gone = signal(false);
  protected readonly password = signal('');
  protected readonly confirm = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly tooShort = computed(
    () => this.password() !== '' && this.password().length < MIN_PASSWORD,
  );
  protected readonly mismatch = computed(
    () => this.confirm() !== '' && this.confirm() !== this.password(),
  );
  protected readonly ready = computed(
    () => this.password().length >= MIN_PASSWORD && this.confirm() === this.password(),
  );

  constructor() {
    // Out of the address bar and history, so a shared screen or a back button cannot replay it.
    history.replaceState(history.state, '', location.pathname);
    void this.#open(); // NOSONAR the load starts with the component; moving it to ngOnInit changes its timing
  }

  async #open(): Promise<void> {
    if (this.#token === '') {
      this.gone.set(true);
      return;
    }
    try {
      this.link.set(
        await firstValueFrom(this.#http.post<Link>('/v1/auth/link', { token: this.#token })),
      );
    } catch {
      this.gone.set(true);
    }
  }

  protected async submit(e: Event): Promise<void> {
    e.preventDefault();
    if (this.busy() || !this.ready()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.#auth.redeemLink(this.#token, this.password());
      await this.#router.navigateByUrl('/');
    } catch (err) {
      const p = toProblem(err);
      if (p.status === 404) this.gone.set(true);
      else if (p.status === 422) this.error.set(issuesOrDetail(p));
      else this.error.set(`${p.title}: ${p.detail}`);
    } finally {
      this.busy.set(false);
    }
  }
}
