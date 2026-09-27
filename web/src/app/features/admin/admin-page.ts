import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { AuditLog } from './audit';
import { RolesMatrix } from './roles';
import { UsersList } from './users';

type Tab = 'users' | 'roles' | 'audit';

/** Who can get in and what they may do: accounts, roles, and the record of changes. */
@Component({
  selector: 'app-admin',
  imports: [AuditLog, RolesMatrix, RouterLink, UsersList],
  template: `
    <section class="gw-page">
      <div class="flex flex-col gap-5">
        <div class="gw-title-rule flex flex-col gap-2.5">
          <h1 class="gw-h1">Admin</h1>
          <p class="m-0 max-w-[62ch] font-serif text-base leading-snug text-muted">
            The people who use this server, what each role may do, and a record of every change.
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
  protected readonly tabs = computed(() =>
    [
      { id: 'users' as Tab, label: 'Users', can: this.#auth.can('users.read') },
      { id: 'roles' as Tab, label: 'Roles', can: this.#auth.can('roles.read') },
      { id: 'audit' as Tab, label: 'Audit log', can: this.#auth.can('audit.read') },
    ].filter((t) => t.can),
  );
  protected readonly tab = computed<Tab | null>(() => {
    const want = this.#query();
    const tabs = this.tabs();
    return tabs.find((t) => t.id === want)?.id ?? tabs[0]?.id ?? null;
  });
  readonly #opened = new Set<Tab>();
  protected readonly opened = computed(() => {
    const t = this.tab();
    if (t) this.#opened.add(t);
    return [...this.#opened];
  });
}
