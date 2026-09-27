import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { AuditLog } from './audit';
import { RolesMatrix } from './roles';
import { SettingsSections, type SettingsGroup } from '../settings/settings';
import { adminTabs, type AdminTab } from './tabs';
import { UsersList } from './users';

const GROUPS: Partial<Record<AdminTab, readonly SettingsGroup[]>> = {
  previews: ['previews'],
  domains: ['domains'],
  github: ['github'],
  server: ['server'],
};

/** Everything about running the server: who may use it, how previews behave, and what changed. */
@Component({
  selector: 'app-admin',
  imports: [AuditLog, RolesMatrix, RouterLink, SettingsSections, UsersList],
  template: `
    <section class="gw-page">
      <div class="flex flex-col gap-5">
        <div class="gw-title-rule flex flex-col gap-2.5">
          <h1 class="gw-h1">Admin</h1>
          <p class="m-0 max-w-[62ch] font-serif text-base leading-snug text-muted">
            Who may use this server and what each role may do, how previews behave, and a record of
            every change.
          </p>
        </div>
        <nav
          class="flex gap-7 overflow-x-auto border-b border-ink text-[13px] font-medium tracking-[.12em] uppercase"
          aria-label="Admin"
        >
          @for (t of tabs(); track t.id) {
            <a
              [routerLink]="[]"
              [queryParams]="{ tab: t.id === tabs()[0]!.id ? null : t.id }"
              class="py-2.5"
              [class]="
                tab() === t.id
                  ? 'shadow-[inset_0_-3px_0_var(--gw-flag)]'
                  : 'text-muted hover:text-ink'
              "
              [attr.aria-current]="tab() === t.id ? 'page' : null"
              [attr.data-testid]="'tab-' + t.id"
              >{{ t.label }}</a
            >
          }
        </nav>
      </div>
      @for (t of opened(); track t) {
        <div [hidden]="tab() !== t" [attr.data-testid]="'panel-' + t">
          @switch (t) {
            @case ('users') {
              <app-users-list />
            }
            @case ('roles') {
              <app-roles-matrix />
            }
            @case ('audit') {
              <app-audit-log />
            }
            @default {
              <app-settings [groups]="groups[t]!" />
            }
          }
        </div>
      } @empty {
        <p class="text-muted" data-testid="no-admin">Your role cannot see any of this.</p>
      }
    </section>
  `,
})
export class AdminPage {
  readonly #auth = inject(AuthService);
  readonly #query = toSignal(inject(ActivatedRoute).queryParamMap.pipe(map((q) => q.get('tab'))), {
    initialValue: null,
  });
  protected readonly groups = GROUPS;
  protected readonly tabs = computed(() => adminTabs((p) => this.#auth.can(p)));
  protected readonly tab = computed<AdminTab | null>(() => {
    const want = this.#query();
    const tabs = this.tabs();
    return tabs.find((t) => t.id === want)?.id ?? tabs[0]?.id ?? null;
  });
  readonly #opened = new Set<AdminTab>();
  protected readonly opened = computed(() => {
    const t = this.tab();
    if (t) this.#opened.add(t);
    return [...this.#opened];
  });
}
