import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { GitHubStatus } from '../../core/api.types';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ToastService } from '../../ui/toast';

/**
 * Where GitHub sends the browser back after creating the App: `?code=…&state=…`. The code
 * is exchanged once, here, and the page moves on. Reloading this URL cannot repeat it --
 * the state was consumed -- which is the point.
 */
@Component({
  selector: 'app-github-callback',
  imports: [Btn, RouterLink],
  template: `
    <section class="mx-auto max-w-lg px-6 py-16 text-center">
      @if (error(); as e) {
        <h1 class="text-lg font-semibold">The GitHub App was not connected</h1>
        <p class="mt-2 text-sm text-red-700 dark:text-red-400" role="alert" data-testid="error">{{ e }}</p>
        <a appBtn routerLink="/settings" class="mt-6 inline-block">Back to Settings</a>
      } @else {
        <h1 class="text-lg font-semibold" data-testid="working">Connecting the GitHub App…</h1>
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
    void this.#exchange();
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
      const status = await firstValueFrom(this.#http.post<GitHubStatus>('/v1/github/manifest/exchange', { code, state }));
      this.#toasts.info(`Connected as ${status.appSlug}`, 'Now install the App on your repositories.');
      await this.#router.navigateByUrl('/settings');
    } catch (e) {
      this.error.set(toProblem(e).detail);
    }
  }
}
