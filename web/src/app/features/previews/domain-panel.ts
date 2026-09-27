import { Component, computed, inject, input, signal, viewChild } from '@angular/core';
import type { Preview } from '../../core/api.types';
import type { PreviewDomains } from '../../core/domain.types';
import { AuthService } from '../../core/auth.service';
import type { ProblemError } from '../../core/problem';
import { FIELD } from '../../ui/field';
import { ToastService } from '../../ui/toast';
import { DomainClaims } from '../domains/domain-claims';
import { PreviewsStore } from './previews.store';

/** Which domain this preview is named under, and hostnames of its own. */
@Component({
  selector: 'app-domain-panel',
  imports: [DomainClaims],
  host: { class: 'flex flex-col gap-2.5' },
  template: `
    @if (shown()) {
      <h2 class="gw-label">Domain</h2>
      <div class="gw-neatline flex flex-col gap-4 px-5 py-4 text-[15px]" data-testid="domain-panel">
        @if ((listing()?.available?.length ?? 0) > 1) {
          <div class="flex flex-wrap items-end gap-6">
            <p class="min-w-48 flex-1">
              The domain its address is named under. A change takes effect on its next deploy or
              rebuild.
              @if (moving(); as m) {
                <span class="text-muted" data-testid="domain-moving"
                  >It moves to {{ m }} then.</span
                >
              }
            </p>
            <label class="gw-label min-w-56"
              >Named under
              <select
                [class]="field"
                [disabled]="!canChange() || saving()"
                (change)="save($any($event.target).value)"
                data-testid="domain-choice"
              >
                <option value="" [selected]="preview().domain === null">
                  Follow the repository and server
                </option>
                @for (d of listing()?.available ?? []; track d) {
                  <option [value]="d" [selected]="d === preview().domain">{{ d }}</option>
                }
              </select></label
            >
          </div>
        }
        <div class="flex flex-col gap-2">
          <p class="text-sm text-muted">
            Hostnames you own that answer for this preview, like www.example.com. Add the records
            shown at your DNS provider; gangway checks every minute and then gets the certificate.
          </p>
          <app-domain-claims
            [url]="url()"
            [kinds]="['exact']"
            [canManage]="canChange()"
            (listed)="listing.set($any($event))"
          />
        </div>
      </div>
    }
  `,
})
export class DomainPanel {
  readonly preview = input.required<Preview>();

  readonly #store = inject(PreviewsStore);
  readonly #toasts = inject(ToastService);
  readonly #auth = inject(AuthService);
  private readonly claims = viewChild(DomainClaims);

  protected readonly field = FIELD;
  protected readonly saving = signal(false);
  protected readonly listing = signal<PreviewDomains | null>(null);
  protected readonly url = computed(() => `/v1/previews/${this.preview().id}/domains`);
  protected readonly canChange = computed(
    () =>
      this.#auth.can('previews.domain') &&
      (this.#auth.can('previews.update') || this.#auth.can('previews.update_own')),
  );
  protected readonly shown = computed(
    () => this.canChange() || (this.listing()?.domains.length ?? 0) > 0,
  );
  /** Where it goes on its next build, when that is not where it is now. */
  protected readonly moving = computed(() => {
    const next = this.listing()?.current;
    const own = this.preview().urls.find((u) => !u.custom)?.url;
    return next && own && !new URL(own).hostname.endsWith(`.${next}`) ? next : null;
  });

  protected async save(value: string): Promise<void> {
    const domain = value === '' ? null : value;
    if (domain === this.preview().domain) return;
    this.saving.set(true);
    try {
      await this.#store.setDomain(this.preview().id, domain);
      await this.claims()?.load();
      this.#toasts.info(`Domain: ${domain ?? 'following the repository'}, from the next rebuild`);
    } catch (e) {
      this.#toasts.problem('Could not change the domain', e as ProblemError);
    } finally {
      this.saving.set(false);
    }
  }
}
