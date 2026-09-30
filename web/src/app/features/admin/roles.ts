import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { Permission } from '../../core/api.types';
import type { PermissionInfo, Role, RolesResponse } from '../../core/admin.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { Skeleton } from '../../ui/skeleton';
import { ToastService } from '../../ui/toast';

type Draft = ReadonlyMap<string, ReadonlySet<Permission>>;

/** Which permissions each role grants, as a grid of checkboxes saved together. */
@Component({
  selector: 'app-roles-matrix',
  imports: [Btn, Skeleton],
  host: { class: 'flex flex-col gap-5' },
  template: `
    <div class="flex flex-wrap items-end gap-4">
      <p class="m-0 max-w-[70ch] text-[13px] leading-snug text-muted">
        A change applies to everyone with the role on their next request, and to their API tokens
        and agents with it. Admin always holds every permission, so no edit here can lock you out.
      </p>
      @if (canManage()) {
        <div class="ml-auto flex items-center gap-2">
          <button
            appBtn
            variant="ghost"
            size="sm"
            type="button"
            [disabled]="changed().length === 0 || saving()"
            (click)="reset()"
            data-testid="roles-reset"
          >
            Undo changes
          </button>
          <button
            appBtn
            size="sm"
            type="button"
            [disabled]="changed().length === 0 || saving()"
            (click)="save()"
            data-testid="roles-save"
          >
            {{ saving() ? 'Saving…' : 'Save' }}
          </button>
        </div>
      }
    </div>

    @if (loading()) {
      <app-skeleton kind="rows" [count]="6" />
    } @else {
      <div class="overflow-x-auto">
        <table class="w-full border-t border-ink text-sm" data-testid="roles">
          <thead>
            <tr class="border-b border-ink">
              <th class="gw-label py-2 pr-4 text-left font-semibold">Permission</th>
              @for (r of roles(); track r.id) {
                <th
                  class="gw-label w-24 px-2 py-2 text-center font-semibold"
                  [title]="r.description"
                >
                  {{ r.name }}
                  @if (changed().includes(r.id)) {
                    <span class="text-flag" [attr.data-testid]="'dirty-' + r.id">•</span>
                  }
                </th>
              }
            </tr>
          </thead>
          @for (g of groups(); track g.feature) {
            <tbody>
              <tr>
                <th
                  [attr.colspan]="roles().length + 1"
                  class="gw-label pt-4 pb-1 text-left font-semibold text-ink"
                >
                  {{ g.feature }}
                </th>
              </tr>
              @for (p of g.permissions; track p.id) {
                <tr class="border-b border-rule" [attr.data-testid]="'perm-' + p.id">
                  <td class="py-2 pr-4">
                    <span class="block">{{ p.description }}</span>
                    <code class="font-mono text-[11px] text-muted">{{ p.id }}</code>
                  </td>
                  @for (r of roles(); track r.id) {
                    <td class="px-2 py-2 text-center">
                      <input
                        type="checkbox"
                        class="gw-box"
                        [checked]="has(r.id, p.id)"
                        [disabled]="!r.editable || !canManage() || saving()"
                        [attr.aria-label]="r.name + ': ' + p.description"
                        (change)="toggle(r.id, p.id)"
                        [attr.data-testid]="'grant-' + r.id + '-' + p.id"
                      />
                    </td>
                  }
                </tr>
              }
            </tbody>
          }
        </table>
      </div>
    }
  `,
})
export class RolesMatrix {
  readonly #http = inject(HttpClient);
  readonly #auth = inject(AuthService);
  readonly #toasts = inject(ToastService);

  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly roles = signal<Role[]>([]);
  readonly #catalogue = signal<PermissionInfo[]>([]);
  readonly #draft = signal<Draft>(new Map());

  protected readonly canManage = computed(() => this.#auth.can('roles.manage'));
  protected readonly groups = computed(() => {
    const by = new Map<string, PermissionInfo[]>();
    for (const p of this.#catalogue()) by.set(p.feature, [...(by.get(p.feature) ?? []), p]);
    return [...by].map(([feature, permissions]) => ({ feature, permissions }));
  });
  protected readonly changed = computed(() =>
    this.roles()
      .filter((r) => r.editable && !sameSet(this.#draft().get(r.id), r.permissions))
      .map((r) => r.id),
  );

  constructor() {
    void this.#load();
  }

  async #load(): Promise<void> {
    try {
      const { roles, catalogue } = await firstValueFrom(this.#http.get<RolesResponse>('/v1/roles'));
      this.roles.set(roles);
      this.#catalogue.set(catalogue);
      this.reset();
    } catch (e) {
      this.#toasts.problem('Could not load roles', toProblem(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected has(role: string, p: Permission): boolean {
    return this.#draft().get(role)?.has(p) ?? false;
  }

  protected toggle(role: string, p: Permission): void {
    const next = new Set(this.#draft().get(role));
    if (!next.delete(p)) next.add(p);
    this.#draft.update((d) => new Map(d).set(role, next));
  }

  protected reset(): void {
    this.#draft.set(new Map(this.roles().map((r) => [r.id, new Set(r.permissions)])));
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    const failed: string[] = [];
    for (const id of this.changed()) {
      const permissions = this.#catalogue()
        .map((p) => p.id)
        .filter((p) => this.has(id, p));
      try {
        const { role } = await firstValueFrom(
          this.#http.put<{ role: Role }>(`/v1/roles/${id}/permissions`, { permissions }),
        );
        this.roles.update((rs) => rs.map((r) => (r.id === role.id ? role : r)));
      } catch (e) {
        failed.push(id);
        this.#toasts.problem(`Could not save the ${id} role`, toProblem(e));
      }
    }
    this.saving.set(false);
    if (failed.length === 0) this.#toasts.info('Roles saved');
    // Your own role may be one of them; the header and pages follow the new grants.
    void this.#auth.refresh();
  }
}

function sameSet(a: ReadonlySet<Permission> | undefined, b: readonly Permission[]): boolean {
  return a?.size === b.length && b.every((p) => a.has(p));
}
