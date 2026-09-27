import { HttpClient } from '@angular/common/http';
import { Component, effect, inject, input, output, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { DomainClaim, DomainKind, DomainListing } from '../../core/domain.types';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { FIELD } from '../../ui/field';

const KIND_LABEL: Record<DomainKind, string> = {
  wildcard: 'Wildcard for previews',
  exact: 'One hostname',
};

export function claimState(d: DomainClaim): string {
  if (d.status === 'failed') return 'Gave up waiting for DNS';
  if (d.status === 'pending') return 'Waiting for DNS';
  return d.routingOk ? 'Active' : 'Active, but DNS does not send it here yet';
}

/**
 * The domains claimed at one level, the DNS records each needs, and a form to claim another.
 * GET and POST go to the same url; checks and removals to /v1/domains/:id.
 */
@Component({
  selector: 'app-domain-claims',
  imports: [Btn],
  template: `
    <ul class="flex flex-col gap-3">
      @for (d of claims(); track d.id) {
        <li class="flex flex-col gap-1.5" data-testid="domain-claim">
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span class="font-mono text-sm"
              >{{ d.kind === 'wildcard' ? '*.' : '' }}{{ d.name }}</span
            >
            <span
              class="text-xs"
              [class.text-ok]="d.status === 'active' && d.routingOk"
              [class.text-danger]="d.status === 'failed'"
              [class.text-muted]="d.status !== 'failed' && !(d.status === 'active' && d.routingOk)"
              data-testid="domain-state"
              >{{ state(d) }}</span
            >
            @if (canManage()) {
              <button
                type="button"
                class="gw-action text-xs"
                [disabled]="busy() === d.id"
                (click)="check(d)"
                data-testid="domain-check"
              >
                Check now
              </button>
              <button
                type="button"
                class="gw-action text-xs hover:text-danger"
                [disabled]="busy() === d.id"
                (click)="remove(d)"
                data-testid="domain-remove"
              >
                Remove
              </button>
            }
          </div>
          @if (d.status !== 'active' || !d.routingOk) {
            <table class="w-full font-mono text-xs" data-testid="domain-records">
              @for (r of d.records; track r.name) {
                <tr class="align-top">
                  <td class="pr-3 text-muted">{{ r.type }}</td>
                  <td class="pr-3 break-all">{{ r.name }}</td>
                  <td class="pr-3 break-all">{{ r.value }}</td>
                  <td class="font-sans text-muted">{{ r.purpose }}</td>
                </tr>
              }
            </table>
          }
        </li>
      } @empty {
        <li class="text-sm text-muted" data-testid="no-domains">None claimed.</li>
      }
    </ul>
    @if (canManage()) {
      <form
        (submit)="claim($event)"
        novalidate
        class="mt-4 flex flex-wrap items-end gap-x-6 gap-y-3"
      >
        <label class="min-w-64 flex-1 flex flex-col gap-1"
          ><span class="gw-label">Domain you own</span
          ><input
            [class]="field"
            [placeholder]="kinds()[0] === 'wildcard' ? 'previews.example.com' : 'www.example.com'"
            autocomplete="off"
            spellcheck="false"
            [value]="name()"
            (input)="name.set($any($event.target).value)"
            data-testid="domain-name"
        /></label>
        @if (kinds().length > 1) {
          <label class="flex flex-col gap-1"
            ><span class="gw-label">As</span
            ><select
              [class]="field"
              (change)="kind.set($any($event.target).value)"
              data-testid="domain-kind"
            >
              @for (k of kinds(); track k) {
                <option [value]="k" [selected]="k === kind()">{{ kindLabel[k] }}</option>
              }
            </select></label
          >
        }
        <button
          appBtn
          variant="ghost"
          size="sm"
          type="submit"
          [disabled]="name().trim() === '' || busy() === 'claim'"
          data-testid="domain-claim-submit"
        >
          Claim
        </button>
      </form>
    }
    @if (error(); as e) {
      <p class="mt-2 text-sm text-danger" role="alert" data-testid="domain-error">{{ e }}</p>
    }
  `,
})
export class DomainClaims {
  readonly url = input.required<string>();
  /** What may be claimed here, the first the default. */
  readonly kinds = input<DomainKind[]>(['exact']);
  readonly canManage = input(false);
  /** The whole answer, each time it is read, for a parent that shows the choices too. */
  readonly listed = output<DomainListing>();
  readonly #http = inject(HttpClient);

  protected readonly field = FIELD;
  protected readonly kindLabel = KIND_LABEL;
  protected readonly state = claimState;
  protected readonly claims = signal<DomainClaim[]>([]);
  protected readonly name = signal('');
  protected readonly kind = signal<DomainKind>('exact');
  protected readonly busy = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      this.kind.set(this.kinds()[0] ?? 'exact');
      void this.load(this.url());
    });
  }

  async load(url = this.url()): Promise<void> {
    try {
      const listing = await firstValueFrom(this.#http.get<DomainListing>(url));
      this.claims.set(listing.domains);
      this.listed.emit(listing);
    } catch (e) {
      this.error.set(toProblem(e).detail);
    }
  }

  protected async claim(e: Event): Promise<void> {
    e.preventDefault();
    const name = this.name().trim().replace(/^\*\./, '');
    const kind = this.name().trim().startsWith('*.') ? 'wildcard' : this.kind();
    await this.#run('claim', async () => {
      const body = this.kinds().length > 1 || kind === 'wildcard' ? { name, kind } : { name };
      await firstValueFrom(this.#http.post(this.url(), body));
      this.name.set('');
    });
  }

  protected check(d: DomainClaim): Promise<void> {
    return this.#run(d.id, () => firstValueFrom(this.#http.post(`/v1/domains/${d.id}/check`, {})));
  }

  protected remove(d: DomainClaim): Promise<void> {
    return this.#run(d.id, () => firstValueFrom(this.#http.delete(`/v1/domains/${d.id}`)));
  }

  async #run(busy: string, fn: () => Promise<unknown>): Promise<void> {
    this.busy.set(busy);
    this.error.set(null);
    try {
      await fn();
      await this.load();
    } catch (err) {
      this.error.set(toProblem(err).detail);
    } finally {
      this.busy.set(null);
    }
  }
}
