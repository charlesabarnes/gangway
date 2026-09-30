import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { GitHubStatus } from '../../core/api.types';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ToastService } from '../../ui/toast';

@Component({
  selector: 'app-github-callback',
  imports: [Btn, RouterLink],
  template: `
    <section class="mx-auto max-w-lg px-6 py-16 text-center">
      @if (error(); as e) {
        <h1 class="font-serif text-3xl italic">The GitHub App was not connected</h1>
        <p class="mt-2 text-sm text-danger" role="alert" data-testid="error">
          {{ e }}
        </p>
        <a appBtn routerLink="/admin" [queryParams]="{ tab: 'github' }" class="mt-6 inline-block"
          >Back to GitHub settings</a
        >
      } @else {
        <h1 class="font-serif text-3xl italic" data-testid="working">Connecting the GitHub App…</h1>
      }
    </section>
  `,
})
export class GitHubCallback {
  readonly #http = inject(HttpClient);
  readonly #router = inject(Router);
  readonly #route = inject(ActivatedRoute);
  readonly #toasts = inject(ToastService);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.#exchange(); // NOSONAR the load starts with the component; moving it to ngOnInit changes its timing
  }

  async #exchange(): Promise<void> {
    const q = this.#route.snapshot.queryParamMap;
    const code = q.get('code');
    const state = q.get('state');
    if (!code || !state) {
      this.error.set('GitHub did not send a code and state back. Start again from Settings.');
      return;
    }
    try {
      const status = await firstValueFrom(
        this.#http.post<GitHubStatus>('/v1/github/manifest/exchange', { code, state }),
      );
      this.#toasts.info(
        `Connected as ${status.appSlug}`,
        'Now install the App on your repositories.',
      );
      await this.#router.navigateByUrl('/admin?tab=github');
    } catch (e) {
      this.error.set(toProblem(e).detail);
    }
  }
}
