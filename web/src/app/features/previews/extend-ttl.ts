import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import type { Preview } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { Clock } from '../../core/clock';
import type { ProblemError } from '../../core/problem';
import { relativeTime } from '../../ui/relative-time.pipe';
import { ToastService } from '../../ui/toast';
import { PreviewsStore } from './previews.store';

const CHOICES = [
  { by: '1d', label: '1 day' },
  { by: '7d', label: '7 days' },
  { by: '30d', label: '30 days' },
  { by: 'none', label: 'forever' },
] as const;

const LINK =
  'text-[13px] text-muted underline underline-offset-2 hover:text-ink disabled:opacity-50';

/** An Extend link that opens to how much longer; added to what the preview has left. */
@Component({
  selector: 'app-extend-ttl',
  host: {
    class: 'inline-flex flex-wrap items-baseline gap-x-2.5 gap-y-1',
    '(keydown.escape)': 'close()',
  },
  template: `
    @if (canExtend()) {
      @if (open()) {
        <span class="text-[13px] text-muted" id="extend-by">Extend by</span>
        @for (c of choices; track c.by) {
          <button
            #choice
            type="button"
            [class]="link"
            [disabled]="saving()"
            (click)="extend(c.by)"
            aria-describedby="extend-by"
            [attr.data-testid]="'extend-' + c.by"
          >
            {{ c.label }}
          </button>
        }
        <button
          type="button"
          class="text-[13px] text-muted hover:text-ink"
          aria-label="Cancel"
          (click)="close()"
          data-testid="extend-cancel"
        >
          ✕
        </button>
      } @else {
        <button
          #toggle
          type="button"
          [class]="link"
          aria-expanded="false"
          (click)="open.set(true)"
          data-testid="extend"
        >
          Extend
        </button>
      }
    }
  `,
})
export class ExtendTtl {
  readonly preview = input.required<Preview>();

  readonly #store = inject(PreviewsStore);
  readonly #toasts = inject(ToastService);
  readonly #auth = inject(AuthService);
  readonly #clock = inject(Clock);
  readonly #injector = inject(Injector);

  protected readonly choices = CHOICES;
  protected readonly link = LINK;
  protected readonly open = signal(false);
  protected readonly saving = signal(false);
  private readonly choiceEls = viewChildren<ElementRef<HTMLButtonElement>>('choice');
  private readonly toggleEl = viewChild<ElementRef<HTMLButtonElement>>('toggle');
  protected readonly canExtend = computed(() => {
    const p = this.preview();
    return (
      p.ttlExpiresAt !== null &&
      p.state !== 'destroying' &&
      p.state !== 'destroyed' &&
      this.#auth.can('previews.extend') &&
      (this.#auth.can('previews.update') || this.#auth.can('previews.update_own'))
    );
  });

  constructor() {
    // Opening moves focus to the first choice; closing hands it back to the link.
    effect(() => {
      if (this.open()) this.choiceEls()[0]?.nativeElement.focus();
    });
  }

  protected close(): void {
    if (!this.open()) return;
    this.open.set(false);
    afterNextRender(() => this.toggleEl()?.nativeElement.focus(), { injector: this.#injector });
  }

  protected async extend(by: string): Promise<void> {
    this.saving.set(true);
    try {
      const p = await this.#store.extend(this.preview().id, by);
      this.close();
      this.#toasts.info(
        p.ttlExpiresAt
          ? `Expires ${relativeTime(p.ttlExpiresAt, this.#clock.now())}`
          : 'Kept until you destroy it',
      );
    } catch (e) {
      this.#toasts.problem('Could not extend the preview', e as ProblemError);
      if ((e as ProblemError).status === 403) void this.#auth.refresh();
    } finally {
      this.saving.set(false);
    }
  }
}
