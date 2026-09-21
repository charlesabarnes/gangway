import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { HealthService } from './health';

@Component({
  selector: 'app-home',
  template: `
    <section class="mx-auto max-w-5xl px-6 py-12">
      <h1 class="text-2xl font-semibold tracking-tight">Previews</h1>
      <p class="mt-2 text-neutral-600 dark:text-neutral-400">
        The list, the detail page and the live log arrive in Phase 2. Until then the API is the interface:
        <code class="font-mono text-sm">POST /v1/previews</code>.
      </p>

      <dl class="mt-10 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-neutral-200 bg-neutral-200 dark:border-neutral-800 dark:bg-neutral-800">
        <div class="bg-white p-5 dark:bg-neutral-900">
          <dt class="text-sm text-neutral-500">Server</dt>
          <dd class="mt-1 font-medium" data-testid="status">
            @switch (health()?.status) {
              @case ('ok') { <span class="text-emerald-600 dark:text-emerald-400">serving</span> }
              @case ('draining') { <span class="text-amber-600 dark:text-amber-400">shutting down</span> }
              @case ('unreachable') { <span class="text-red-600 dark:text-red-400">unreachable</span> }
              @default { <span class="text-neutral-400">checking…</span> }
            }
          </dd>
        </div>
        <div class="bg-white p-5 dark:bg-neutral-900">
          <dt class="text-sm text-neutral-500">Routes</dt>
          <dd class="mt-1 font-mono font-medium" data-testid="routes">{{ routes() }}</dd>
        </div>
      </dl>
    </section>
  `,
})
export class Home {
  protected readonly health = toSignal(inject(HealthService).check());
  protected routes(): string {
    const h = this.health();
    return h?.status === 'ok' ? String(h.routes) : '—';
  }
}
