import { HttpClient } from '@angular/common/http';
import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { Preview } from '../../core/api.types';
import type { ShareStatus } from '../../core/share.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ClipboardService } from '../../ui/clipboard';
import { FIELD } from '../../ui/field';
import { ToastService } from '../../ui/toast';

const HOUR = 3_600_000;
const LENGTHS: readonly { ttl: string; ms: number; label: string }[] = [
  { ttl: '1h', ms: HOUR, label: '1 hour' },
  { ttl: '4h', ms: 4 * HOUR, label: '4 hours' },
  { ttl: '24h', ms: 24 * HOUR, label: '1 day' },
  { ttl: '7d', ms: 168 * HOUR, label: '1 week' },
];

/** A public link for this preview through a Cloudflare quick tunnel, for as long as it is wanted. */
@Component({
  selector: 'app-share-panel',
  imports: [Btn, DatePipe],
  host: { class: 'flex flex-col gap-2.5' },
  template: `
    @if (status(); as s) {
      @if (s.available || s.share) {
        <h2 class="gw-label">Share</h2>
        <div
          class="gw-neatline flex flex-col gap-3 px-5 py-4 text-[15px]"
          data-testid="share-panel"
        >
          @if (s.share; as share) {
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
              <a
                class="font-mono text-sm break-all underline"
                [href]="share.url"
                target="_blank"
                rel="noopener"
                data-testid="share-url"
                >{{ share.url }}</a
              >
              <button type="button" class="gw-action text-xs" (click)="copy(share.url)">
                Copy
              </button>
              @if (canShare()) {
                <button
                  type="button"
                  class="gw-action text-xs hover:text-danger"
                  [disabled]="busy()"
                  (click)="stop()"
                  data-testid="share-stop"
                >
                  Stop sharing
                </button>
              }
            </div>
            <p class="text-sm text-muted">
              Public until {{ share.expiresAt | date: 'MMM d, HH:mm' }}. Anyone with the link can
              open it.
            </p>
          } @else {
            <div class="flex flex-wrap items-end gap-6">
              <p class="min-w-48 flex-1" data-testid="share-intro">
                @if (s.local) {
                  This preview opens only on the machine gangway runs on. Share it to get a public
                  link anyone can open.
                } @else {
                  Get a public link for someone who cannot reach this server.
                }
              </p>
              @if (canShare()) {
                <div class="flex items-end gap-3">
                  <label class="gw-label"
                    >For
                    <select
                      [class]="field"
                      [disabled]="busy()"
                      (change)="ttl.set($any($event.target).value)"
                      data-testid="share-ttl"
                    >
                      @for (l of lengths(); track l.ttl) {
                        <option [value]="l.ttl" [selected]="l.ttl === ttl()">{{ l.label }}</option>
                      }
                    </select></label
                  >
                  <button
                    appBtn
                    type="button"
                    [disabled]="busy()"
                    (click)="start()"
                    data-testid="share-start"
                  >
                    {{ busy() ? 'Opening…' : 'Share publicly' }}
                  </button>
                </div>
              }
            </div>
          }
          <p class="text-xs text-muted">
            Through a Cloudflare quick tunnel, for testing: at most 200 requests at once, no
            server-sent events, and a new link each time. The preview's password still applies; a
            preview that needs signing in sends visitors to this server's login.
          </p>
        </div>
      }
    }
  `,
})
export class SharePanel {
  readonly preview = input.required<Preview>();

  readonly #http = inject(HttpClient);
  readonly #auth = inject(AuthService);
  readonly #toasts = inject(ToastService);
  readonly #clipboard = inject(ClipboardService);

  protected readonly field = FIELD;
  protected readonly status = signal<ShareStatus | null>(null);
  protected readonly busy = signal(false);
  protected readonly ttl = signal('4h');
  protected readonly canShare = computed(
    () =>
      this.#auth.can('previews.share') &&
      (this.#auth.can('previews.update') || this.#auth.can('previews.update_own')),
  );
  protected readonly lengths = computed(() => {
    const max = this.status()?.maxTtlMs ?? 0;
    const fit = LENGTHS.filter((l) => l.ms <= max);
    return fit.length > 0 ? fit : LENGTHS.slice(0, 1);
  });
  readonly #url = computed(() => `/v1/previews/${this.preview().id}/share`);

  constructor() {
    effect(() => {
      const url = this.#url();
      untracked(() => void this.#load(url));
    });
  }

  async #load(url: string): Promise<void> {
    try {
      this.status.set(await firstValueFrom(this.#http.get<ShareStatus>(url)));
    } catch {
      this.status.set(null);
    }
  }

  protected async start(): Promise<void> {
    const ttl = this.lengths().some((l) => l.ttl === this.ttl()) ? this.ttl() : undefined;
    await this.#run('Could not share it', async () => {
      const s = await firstValueFrom(this.#http.post<ShareStatus>(this.#url(), { ttl }));
      this.status.set(s);
      if (s.share) await this.copy(s.share.url);
    });
  }

  protected async stop(): Promise<void> {
    await this.#run('Could not stop sharing', async () => {
      this.status.set(await firstValueFrom(this.#http.delete<ShareStatus>(this.#url())));
      this.#toasts.info('Stopped sharing', 'The link no longer opens this preview.');
    });
  }

  protected copy(url: string): Promise<void> {
    return this.#clipboard.copy(
      url,
      ['Public link copied', url],
      ['Public link', `Copy it from the page: ${url}`],
    );
  }

  async #run(failed: string, work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    try {
      await work();
    } catch (e) {
      this.#toasts.problem(failed, toProblem(e));
    } finally {
      this.busy.set(false);
    }
  }
}
