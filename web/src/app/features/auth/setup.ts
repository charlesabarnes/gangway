import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { issuesOrDetail, toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ErrorAlert } from '../../ui/error-alert';
import { AuthCard, FIELD, LABEL } from './auth-card';

const MIN_PASSWORD = 12;

@Component({
  selector: 'app-setup',
  imports: [AuthCard, Btn, ErrorAlert],
  template: `
    <app-auth-card heading="Create the first admin">
      <span lede
        >Nobody has an account yet. This one can do everything, including making the others.</span
      >

      @if (!token) {
        <app-error-alert class="px-3 py-2.5" data-testid="no-token">
          <p class="font-medium">This page needs the setup link.</p>
          <p class="mt-1">
            gangway printed a one-time URL when it started. Find it in the server's output —
            <code class="font-mono text-xs">docker logs gangway</code> — and open that instead.
          </p>
        </app-error-alert>
      } @else {
        <form (submit)="submit($event)" novalidate class="space-y-[18px]">
          @if (error(); as e) {
            <app-error-alert class="px-3 py-2.5" data-testid="error">
              <p>{{ e.message }}</p>
              @if (e.hint) {
                <p class="mt-1 text-xs opacity-80">{{ e.hint }}</p>
              }
            </app-error-alert>
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
              autocomplete="new-password"
              required
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
            {{ busy() ? 'Creating…' : 'Create admin and log in' }}
          </button>
        </form>
      }
    </app-auth-card>
  `,
})
export class Setup {
  readonly #auth = inject(AuthService);
  readonly #router = inject(Router);

  protected readonly token = inject(ActivatedRoute).snapshot.queryParamMap.get('token');
  protected readonly min = MIN_PASSWORD;
  protected readonly field = FIELD;
  protected readonly label = LABEL;

  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly confirm = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<{ message: string; hint?: string } | null>(null);

  protected readonly tooShort = computed(
    () => this.password() !== '' && this.password().length < MIN_PASSWORD,
  );
  protected readonly mismatch = computed(
    () => this.confirm() !== '' && this.confirm() !== this.password(),
  );
  protected readonly ready = computed(
    () =>
      this.email().trim() !== '' &&
      this.password().length >= MIN_PASSWORD &&
      this.confirm() === this.password(),
  );

  protected async submit(e: Event): Promise<void> {
    e.preventDefault();
    if (this.busy() || !this.ready() || !this.token) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.#auth.setup(this.token, this.email().trim(), this.password());
      await this.#router.navigateByUrl('/');
    } catch (err) {
      const p = toProblem(err);
      if (p.status === 403) {
        this.error.set({
          message: 'That setup link is not valid.',
          hint: 'A new link is printed every time gangway starts; an older one stops working. Use the most recent one in the server output.',
        });
      } else if (p.status === 404) {
        this.error.set({
          message: 'Setup has already been completed.',
          hint: 'An admin account exists. Log in instead.',
        });
      } else if (p.status === 422) {
        this.error.set({
          message: issuesOrDetail(p),
        });
      } else {
        this.error.set({
          message: `${p.title}: ${p.detail}`,
          ...(p.requestId ? { hint: `request ${p.requestId}` } : {}),
        });
      }
    } finally {
      this.busy.set(false);
    }
  }
}
