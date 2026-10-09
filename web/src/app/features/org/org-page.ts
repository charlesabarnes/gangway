import { HttpClient } from '@angular/common/http';
import { Component, computed, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import type { OrgMember, OrgOverview } from '../../core/org.types';
import { QueryCache } from '../../core/query';
import { ErrorAlert } from '../../ui/error-alert';
import { Skeleton } from '../../ui/skeleton';

type Meter = { label: string; used: string; max: string | null; ratio: number | null; id: string };

// Decimal, as the server counts a plan's storage in its refusals.
export function formatSize(n: number): string {
  if (n >= 1e9) return `${Math.round(n / 1e8) / 10} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e5) / 10} MB`;
  return `${Math.round(n / 100) / 10} kB`;
}

const meter = (
  id: string,
  label: string,
  used: number,
  max: number | undefined,
  fmt: (n: number) => string = String,
): Meter => ({
  id,
  label,
  used: fmt(used),
  max: max === undefined ? null : fmt(max),
  ratio: max === undefined ? null : max === 0 ? 1 : Math.min(1, used / max),
});

/** The current org as its own people see it: the plan, what it allows next to what is in use, and who is in it. */
@Component({
  selector: 'app-org-page',
  imports: [ErrorAlert, Skeleton],
  template: `
    <section class="gw-page">
      <div class="gw-title-rule flex flex-wrap items-end justify-between gap-4">
        <h1 class="gw-h1" data-testid="org-name">
          {{ overview.data()?.org?.name ?? 'Organisation' }}
        </h1>
        @if (overview.data()?.billingUrl; as url) {
          <a
            class="text-sm font-medium underline decoration-flag decoration-2 underline-offset-4 hover:decoration-ink"
            [href]="url"
            target="_blank"
            rel="noopener"
            data-testid="manage-plan"
            >Manage plan</a
          >
        }
      </div>

      @if (overview.error(); as e) {
        <app-error-alert [problem]="e" />
      } @else if (overview.data(); as o) {
        <div class="gw-neatline flex flex-col gap-5 p-6" data-testid="usage">
          <div class="flex flex-wrap items-baseline gap-3">
            <h2 class="gw-h2">Plan</h2>
            <span class="gw-tag" data-testid="plan-label">{{ o.planLabel ?? 'No plan' }}</span>
            @if (o.org.state === 'suspended') {
              <span class="gw-tag border-danger text-danger" data-testid="suspended"
                >Suspended</span
              >
            }
          </div>
          @if (o.limits?.containers === false) {
            <p class="text-[13px] text-muted" data-testid="static-only">
              This plan serves static sites and artifacts. It does not run app containers.
            </p>
          }
          <dl class="grid gap-x-10 gap-y-4 sm:grid-cols-2">
            @for (m of meters(); track m.id) {
              <div class="flex flex-col gap-1.5" [attr.data-testid]="'meter-' + m.id">
                <div class="gw-fact">
                  <dt>{{ m.label }}</dt>
                  <dd [attr.data-testid]="'meter-' + m.id + '-value'">
                    {{ m.used }}{{ m.max === null ? '' : ' of ' + m.max }}
                  </dd>
                </div>
                @if (m.ratio !== null) {
                  <div class="h-1 bg-rule" aria-hidden="true">
                    <div
                      class="h-full"
                      [class.bg-ink]="m.ratio < 0.9"
                      [class.bg-danger]="m.ratio >= 0.9"
                      [style.width.%]="m.ratio * 100"
                    ></div>
                  </div>
                }
              </div>
            }
          </dl>
          @if (!o.limits) {
            <p class="text-[13px] text-muted">No limits are set for this organisation.</p>
          }
        </div>
      } @else {
        <app-skeleton kind="rows" [count]="2" />
      }

      <div class="flex flex-col gap-3">
        <h2 class="gw-h2">Members</h2>
        @if (members.error(); as e) {
          <app-error-alert [problem]="e" />
        } @else if (members.data(); as list) {
          <div class="overflow-x-auto">
            <table class="w-full border-t border-ink text-sm" data-testid="members">
              <thead>
                <tr class="border-b border-ink text-left">
                  <th class="gw-label py-2 pr-4 font-semibold">Email</th>
                  <th class="gw-label py-2 pr-4 font-semibold">Role</th>
                  <th class="gw-label py-2 pr-4 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                @for (m of list; track m.id) {
                  <tr
                    class="border-b border-rule"
                    [class.opacity-60]="m.disabled"
                    data-testid="member-row"
                  >
                    <td class="py-2.5 pr-4 text-[15px] break-all">
                      {{ m.email }}
                      @if (m.id === me()) {
                        <span class="gw-tag ml-1.5">you</span>
                      }
                    </td>
                    <td class="py-2.5 pr-4">{{ m.role.name }}</td>
                    <td class="py-2.5 pr-4">
                      {{ m.disabled ? 'Disabled' : m.invited ? 'Invited' : 'Active' }}
                    </td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="3" class="py-3 text-muted">No one yet.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <app-skeleton kind="rows" [count]="3" />
        }
      </div>
    </section>
  `,
})
export class OrgPage {
  readonly #http = inject(HttpClient);
  readonly #queries = inject(QueryCache);
  readonly #auth = inject(AuthService);

  protected readonly overview = this.#queries.query('org', () =>
    firstValueFrom(this.#http.get<OrgOverview>('/v1/org')),
  );
  protected readonly members = this.#queries.query('org/members', () =>
    firstValueFrom(this.#http.get<{ members: OrgMember[] }>('/v1/org/members')).then(
      (r) => r.members,
    ),
  );
  protected readonly me = computed(() => this.#auth.user()?.id ?? null);

  protected readonly meters = computed<Meter[]>(() => {
    const o = this.overview.data();
    if (!o) return [];
    const l = o.limits ?? {};
    const all = [
      meter('sites', 'Sites', o.usage.sites, l.maxSites),
      meter('storage', 'Site storage', o.usage.storageBytes, l.storageBytes, formatSize),
      meter('members', 'Members', o.usage.members, l.maxMembers),
    ];
    if (l.containers !== false) {
      all.splice(1, 0, meter('apps', 'App previews', o.usage.apps, l.maxActive));
    }
    return all;
  });
}
