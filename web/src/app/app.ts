import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { AuthService } from './core/auth.service';
import { HealthService } from './health';
import { Toasts } from './ui/toast';

@Component({
  imports: [RouterLink, RouterLinkActive, RouterOutlet, Toasts],
  selector: 'app-root',
  templateUrl: './app.html',
})
export class App {
  protected readonly auth = inject(AuthService);
  readonly #router = inject(Router);

  protected readonly health = toSignal(inject(HealthService).check());
  readonly #url = toSignal(this.#router.events.pipe(filter((e) => e instanceof NavigationEnd), map((e) => e.urlAfterRedirects)), { initialValue: this.#router.url });

  /** Login and setup bring their own frame; the app header is for people who are in. The workspace is full-screen. */
  protected readonly chrome = computed(() => this.auth.authenticated() && !/^\/(login|setup)(\?|\/|$)/.test(this.#url()) && !/^\/previews\/[^/?]+\/edit(\?|$)/.test(this.#url()));

  protected async logout(): Promise<void> {
    await this.auth.logout().catch(() => {});
    await this.#router.navigateByUrl('/login');
  }
}
