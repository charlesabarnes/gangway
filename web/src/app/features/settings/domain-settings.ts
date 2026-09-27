import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, input, model, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { SettingView } from '../../core/api.types';
import type { OrgDomains } from '../../core/domain.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { FIELD } from '../../ui/field';
import { ToastService } from '../../ui/toast';
import { DomainClaims } from '../domains/domain-claims';

const DEFAULT = 'previewDomain';

/** The server's own preview domains, and which one previews get when nothing chose another. */
@Component({
  selector: 'app-domain-settings',
  imports: [DomainClaims],
  host: { class: 'block' },
  template: `
    <div class="gw-section">
      <div class="flex flex-col gap-1">
        <h2 class="gw-h2">Domains</h2>
        <p class="gw-section-note">
          Previews are named &lt;label&gt;.&lt;domain&gt;. Add a domain you own as a wildcard and
          every repository and preview can choose it; each can also claim its own.
        </p>
      </div>
      <div class="flex flex-col gap-5">
        <label class="gw-label min-w-72 self-start"
          >Previews are named under
          <select
            [class]="field"
            [disabled]="!canWrite() || managed() || saving() !== null"
            (change)="setDefault($any($event.target).value)"
            data-testid="default-domain"
          >
            @for (d of org()?.available ?? []; track d) {
              <option [value]="d" [selected]="d === org()?.defaultDomain">{{ d }}</option>
            }
          </select>
          @if (managed()) {
            <span class="text-xs text-muted">managed by config</span>
          }
        </label>
        <app-domain-claims
          url="/v1/domains"
          [kinds]="['wildcard']"
          [canManage]="canManage()"
          (listed)="org.set($any($event))"
        />
      </div>
    </div>
  `,
})
export class DomainSettings {
  readonly settings = input.required<SettingView[]>();
  readonly saving = model.required<string | null>();

  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);
  readonly #auth = inject(AuthService);

  protected readonly field = FIELD;
  protected readonly org = signal<OrgDomains | null>(null);
  protected readonly canWrite = computed(() => this.#auth.can('settings.write'));
  protected readonly canManage = computed(() => this.#auth.can('domains.manage'));
  protected readonly managed = computed(
    () => this.settings().find((s) => s.key === DEFAULT)?.managedByConfig === true,
  );

  protected async setDefault(domain: string): Promise<void> {
    const org = this.org();
    if (!org || domain === org.defaultDomain || this.saving() !== null) return;
    this.saving.set(DEFAULT);
    try {
      const value = domain === org.control ? '' : domain;
      await firstValueFrom(this.#http.put('/v1/settings', { values: { [DEFAULT]: value } }));
      this.org.set({ ...org, defaultDomain: domain });
      this.#toasts.info(`New previews are named under ${domain}`);
    } catch (e) {
      this.#toasts.problem('Could not change the default domain', toProblem(e));
    } finally {
      this.saving.set(null);
    }
  }
}
