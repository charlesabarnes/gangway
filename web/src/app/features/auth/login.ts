import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { HARD_NAVIGATE, isServerReturn, safeReturnUrl } from '../../core/auth.guard';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ErrorAlert } from '../../ui/error-alert';
import { AuthCard, FIELD, LABEL } from './auth-card';

@Component({
  selector: 'app-login',
  imports: [AuthCard, Btn, ErrorAlert],
  template: `
    <app-auth-card heading="Log in">
      <span lede>Use the account your gangway admin gave you.</span>

      <form (submit)="submit($event)" novalidate class="space-y-5">
        @if (auth.unreachable()) {
          <app-error-alert class="px-3 py-2.5" data-testid="unreachable">
            Cannot reach the server. It may be restarting — try again in a moment.
          </app-error-alert>
        }
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
        <div>
          <label for="password" [class]="label">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autocomplete="current-password"
            required
            [class]="field"
            [value]="password()"
            (input)="password.set($any($event.target).value)"
            data-testid="password"
          />
        </div>

        <button
          appBtn
          type="submit"
          class="w-full"
          [disabled]="busy() || lockedFor() > 0"
          data-testid="submit"
        >
          @if (lockedFor() > 0) {
            Try again in {{ countdown() }}
          } @else if (busy()) {
            Logging in…
          } @else {
            Log in
          }
        </button>
      </form>
    </app-auth-card>
  `,
})
export class Login {
  protected readonly auth = inject(AuthService);
  readonly #router = inject(Router);
  readonly #route = inject(ActivatedRoute);
  readonly #hardNavigate = inject(HARD_NAVIGATE);

  protected readonly field = FIELD;
  protected readonly label = LABEL;

  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly lockedFor = signal(0);
  protected readonly countdown = computed(() => {
    const s = this.lockedFor();
    return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
  });
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.#stop());
  }

  protected async submit(e: Event): Promise<void> {
    e.preventDefault();
    if (this.busy() || this.lockedFor() > 0) return;
    if (this.email().trim() === '' || this.password() === '') {
      this.error.set('Enter your email and password.');
      return;
    }

    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.login(this.email().trim(), this.password());
      const to = safeReturnUrl(this.#route.snapshot.queryParamMap.get('returnUrl'));
      if (isServerReturn(to)) this.#hardNavigate(to);
      else await this.#router.navigateByUrl(to);
    } catch (err) {
      const p = toProblem(err);
      this.password.set('');
      if (p.status === 429) {
        this.error.set('Too many failed attempts. Logging in is paused for a moment.');
        this.#lock(p.retryAfter ?? 60);
      } else if (p.status === 401) {
        this.error.set('Wrong email or password.');
      } else {
        this.error.set(
          p.requestId
            ? `${p.title}: ${p.detail} (request ${p.requestId})`
            : `${p.title}: ${p.detail}`,
        );
      }
    } finally {
      this.busy.set(false);
    }
  }

  #lock(seconds: number): void {
    this.#stop();
    this.lockedFor.set(Math.ceil(seconds));
    this.#timer = setInterval(() => {
      this.lockedFor.update((s) => Math.max(0, s - 1));
      if (this.lockedFor() === 0) {
        this.#stop();
        this.error.set(null);
      }
    }, 1000);
  }

  #stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
