import { Component, computed, inject } from '@angular/core';
import { AuthService } from '../../core/auth.service';
import { ApiTokens } from './api-tokens';
import { ChangePassword } from './change-password';

@Component({
  selector: 'app-account',
  imports: [ApiTokens, ChangePassword],
  template: `
    <section class="mx-auto max-w-3xl px-6 py-10">
      <h1 class="text-2xl font-semibold tracking-tight">Account</h1>

      @if (auth.user(); as user) {
        <div
          class="mt-6 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
          data-testid="identity"
        >
          <p class="font-medium">{{ user.email }}</p>
          <p class="mt-0.5 text-sm text-neutral-500">
            Role: <span class="text-neutral-800 dark:text-neutral-200">{{ user.role.name }}</span>
          </p>
          <p class="mt-4 text-xs text-neutral-500">
            What this role may do. An admin can change it, and changes apply at once — no need to
            log in again.
          </p>
          <dl class="mt-2 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2" data-testid="permissions">
            @for (g of grouped(); track g.feature) {
              <div class="flex gap-2">
                <dt class="w-20 shrink-0 text-neutral-500">{{ g.feature }}</dt>
                <dd>{{ g.verbs.join(', ') }}</dd>
              </div>
            } @empty {
              <p class="text-neutral-500">Nothing. Ask an admin.</p>
            }
          </dl>
        </div>
      }

      <app-change-password />

      @if (canTokens()) {
        <app-api-tokens />
      }
    </section>
  `,
})
export class Account {
  protected readonly auth = inject(AuthService);

  protected readonly canTokens = computed(() => this.auth.can('tokens.manage_own'));
  protected readonly grouped = computed(() => {
    const by = new Map<string, string[]>();
    for (const p of [...this.auth.permissions()].sort()) {
      const [feature = '', verb = ''] = p.split('.');
      by.set(feature, [...(by.get(feature) ?? []), verb.replace(/_/g, ' ')]);
    }
    return [...by].map(([feature, verbs]) => ({ feature, verbs }));
  });
}
