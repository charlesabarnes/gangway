import { Component, computed, inject } from '@angular/core';
import { AuthService } from '../../core/auth.service';
import { ApiTokens } from './api-tokens';
import { ChangePassword } from './change-password';

@Component({
  selector: 'app-account',
  imports: [ApiTokens, ChangePassword],
  template: `
    <section class="gw-page">
      <div class="gw-title-rule"><h1 class="gw-h1">Account</h1></div>

      @if (auth.user(); as user) {
        <div
          class="gw-neatline grid gap-6 p-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] md:gap-10"
          data-testid="identity"
        >
          <div class="flex flex-col gap-1.5">
            <p class="font-mono text-xl font-medium tracking-[-.02em] break-all">
              {{ user.email }}
            </p>
            <p class="text-[15px] text-muted">
              Role: <span class="text-ink">{{ user.role.name }}</span>
            </p>
            <p class="mt-2.5 text-[13px] leading-snug text-muted">
              What this role may do. An admin can change it, and changes apply at once — no need to
              log in again.
            </p>
          </div>
          <dl
            class="grid content-start gap-x-7 gap-y-2 text-sm sm:grid-cols-2"
            data-testid="permissions"
          >
            @for (g of grouped(); track g.feature) {
              <div class="flex items-baseline gap-1.5">
                <dt class="whitespace-nowrap text-muted">{{ g.feature }}</dt>
                <span
                  class="flex-1 -translate-y-1 border-b border-dotted border-rule"
                  aria-hidden="true"
                ></span>
                <dd class="text-right">{{ g.verbs.join(', ') }}</dd>
              </div>
            } @empty {
              <p class="text-muted">Nothing. Ask an admin.</p>
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
