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
import type { ProblemError } from '../../core/problem';
import { ToastService } from '../../ui/toast';
import { PreviewsStore } from './previews.store';

const CHOICES = [
  { idle: '30m', label: '30 minutes' },
  { idle: '2h', label: '2 hours' },
  { idle: '1d', label: '1 day' },
  { idle: 'never', label: 'never' },
] as const;

const LINK =
  'text-[13px] text-muted underline underline-offset-2 hover:text-ink disabled:opacity-50';

const UNITS: readonly (readonly [number, string])[] = [
  [86_400_000, 'day'],
  [3_600_000, 'hour'],
  [60_000, 'minute'],
  [1_000, 'second'],
];

export function idleText(ms: number): string {
  const [size, name] = UNITS.find(([u]) => ms % u === 0) ?? [1_000, 'second'];
  const n = Math.round(ms / size);
  return `${n} ${name}${n === 1 ? '' : 's'}`;
}

/** When an app sleeps for want of requests, with a link that opens to change it. */
@Component({
  selector: 'app-idle-window',
  host: {
    '[class.gw-fact]': 'sleeps()',
    '[class.hidden]': '!sleeps()',
    '(keydown.escape)': 'close()',
  },
  template: `
    @if (sleeps()) {
      <dt>Sleeps</dt>
      <dd class="inline-flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span data-testid="idle">{{ now() }}</span>
        @if (canChange()) {
          @if (open()) {
            <span class="text-[13px] text-muted" id="idle-after">Sleep after</span>
            @for (c of choices; track c.idle) {
              <button
                #choice
                type="button"
                [class]="link"
                [disabled]="saving()"
                (click)="change(c.idle)"
                aria-describedby="idle-after"
                [attr.data-testid]="'idle-' + c.idle"
              >
                {{ c.label }}
              </button>
            }
            <button
              type="button"
              class="text-[13px] text-muted hover:text-ink"
              aria-label="Cancel"
              (click)="close()"
              data-testid="idle-cancel"
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
              data-testid="idle-change"
            >
              Change
            </button>
          }
        }
      </dd>
    }
  `,
})
export class IdleWindow {
  readonly preview = input.required<Preview>();

  readonly #store = inject(PreviewsStore);
  readonly #toasts = inject(ToastService);
  readonly #auth = inject(AuthService);
  readonly #injector = inject(Injector);

  protected readonly choices = CHOICES;
  protected readonly link = LINK;
  protected readonly open = signal(false);
  protected readonly saving = signal(false);
  private readonly choiceEls = viewChildren<ElementRef<HTMLButtonElement>>('choice');
  private readonly toggleEl = viewChild<ElementRef<HTMLButtonElement>>('toggle');

  /** Only containers sleep: files that gangway serves cost nothing while nobody reads them. */
  protected readonly sleeps = computed(() => {
    const p = this.preview();
    return p.kind !== 'job' && !(p.source.kind === 'tarball' && p.source.serve === 'gangway');
  });
  protected readonly now = computed(() => {
    const ms = this.preview().idleAfterMs;
    if (ms === null) return "after the server's default";
    return ms === 0 ? 'never' : `after ${idleText(ms)} idle`;
  });
  protected readonly canChange = computed(() => {
    const p = this.preview();
    return (
      p.state !== 'destroying' &&
      p.state !== 'destroyed' &&
      (this.#auth.can('previews.update') || this.#auth.can('previews.update_own'))
    );
  });

  constructor() {
    effect(() => {
      if (this.open()) this.choiceEls()[0]?.nativeElement.focus();
    });
  }

  protected close(): void {
    if (!this.open()) return;
    this.open.set(false);
    afterNextRender(() => this.toggleEl()?.nativeElement.focus(), { injector: this.#injector });
  }

  protected async change(idle: string): Promise<void> {
    this.saving.set(true);
    try {
      const p = await this.#store.setIdle(this.preview().id, idle);
      this.close();
      this.#toasts.info(
        p.idleAfterMs === 0
          ? 'Stays awake'
          : `Sleeps after ${idleText(p.idleAfterMs ?? 0)} with no requests`,
      );
    } catch (e) {
      this.#toasts.problem('Could not change when it sleeps', e as ProblemError);
      if ((e as ProblemError).status === 403) void this.#auth.refresh();
    } finally {
      this.saving.set(false);
    }
  }
}
