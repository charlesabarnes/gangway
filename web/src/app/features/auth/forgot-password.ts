import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ErrorAlert } from '../../ui/error-alert';
import { AuthCard, FIELD, LABEL } from './auth-card';

@Component({
  selector: 'app-forgot-password',
  imports: [AuthCard, Btn, ErrorAlert, RouterLink],
  template: `
    <app-auth-card heading="Forgot your password?">
      <span lede>We'll email you a link to choose a new one.</span>

      @if (sentTo(); as to) {
        <div class="space-y-[18px]" role="status" data-testid="sent">
          <p class="text-[15px] leading-snug">
            If <span class="font-mono">{{ to }}</span> has an account here, a link is on its way. It
            works once, for an hour.
          </p>
          <p class="text-sm leading-snug text-muted">
            Nothing after a few minutes? Check your spam folder, or ask your gangway admin.
          </p>
          <a routerLink="/login" class="gw-action inline-block" data-testid="back"
            >Back to log in</a
          >
        </div>
      } @else {
        <form (submit)="submit($event)" novalidate class="space-y-[18px]">
          @if (error(); as e) {
            <app-error-alert class="px-3 py-2.5" data-testid="error">{{ e }}</app-error-alert>
          }
          <div>
            <label for="email" [class]="label">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autocomplete="username"
              required
              autofocus
              [class]="field"
              [value]="email()"
              (input)="email.set($any($event.target).value)"
              data-testid="email"
            />
          </div>
          <button
            appBtn
            type="submit"
            class="w-full !py-[13px] !text-sm !tracking-[.14em]"
            [disabled]="busy()"
            data-testid="submit"
          >
            {{ busy() ? 'Sending…' : 'Email me a link' }}
          </button>
          <a routerLink="/login" class="gw-action inline-block" data-testid="back"
            >Back to log in</a
          >
        </form>
      }
    </app-auth-card>
  `,
})
export class ForgotPassword {
  readonly #http = inject(HttpClient);

  protected readonly field = FIELD;
  protected readonly label = LABEL;

  protected readonly email = signal(
    inject(ActivatedRoute).snapshot.queryParamMap.get('email') ?? '',
  );
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly sentTo = signal<string | null>(null);

  protected async submit(e: Event): Promise<void> {
    e.preventDefault();
    const email = this.email().trim();
    if (this.busy()) return;
    if (!email.includes('@')) {
      this.error.set('Enter the email address you log in with.');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.#http.post('/v1/auth/password-reset', { email }));
      this.sentTo.set(email);
    } catch (err) {
      const p = toProblem(err);
      if (p.status === 429) this.error.set('A link was sent a moment ago. Check your email.');
      else if (p.status === 409)
        this.error.set('This server cannot send email. Ask your gangway admin for a new password.');
      else this.error.set(`${p.title}: ${p.detail}`);
    } finally {
      this.busy.set(false);
    }
  }
}
