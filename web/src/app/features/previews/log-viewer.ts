import {
  Component,
  DestroyRef,
  ElementRef,
  InjectionToken,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { LOG_STREAMS, type LogLine, type LogStream } from '../../core/api.types';
import { SseService, type SseHandle } from '../../core/sse.service';
import { ConnectionDot } from '../../ui/connection-dot';
import { LogBuffer, isStuckToBottom } from './log-buffer';

export const FRAME = new InjectionToken<(cb: () => void) => void>('FRAME', {
  providedIn: 'root',
  factory: () => (cb: () => void) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cb);
    else setTimeout(cb, 16);
  },
});

const TAIL = 2_000;

const STREAM_CLASS: Record<LogStream, string> = {
  system: 'text-[oklch(0.8_0.09_220)]',
  build: 'text-[oklch(0.7_0.02_250)]',
  seed: 'text-[oklch(0.8_0.08_300)]',
  stdout: 'text-log-fg',
  stderr: 'text-flag',
};

@Component({
  selector: 'app-log-viewer',
  imports: [ConnectionDot],
  template: `
    <div class="overflow-hidden bg-log text-log-fg">
      <div
        class="flex flex-wrap items-center gap-0.5 border-b border-white/12 px-3 py-2 text-xs font-medium tracking-[.12em] uppercase"
      >
        @for (f of filters; track f) {
          <button
            type="button"
            (click)="filter.set(f)"
            [attr.aria-pressed]="filter() === f"
            [attr.data-testid]="'stream-' + f"
            class="px-2.5 py-[3px] uppercase focus-visible:outline-2 focus-visible:outline-flag"
            [class]="filter() === f ? 'bg-flag text-flag-fg' : 'opacity-60 hover:opacity-100'"
          >
            {{ f }}
          </button>
        }
        <span class="ml-auto tracking-normal normal-case opacity-80 [&_[role=status]]:!text-log-fg"
          ><app-connection-dot [status]="status()"
        /></span>
      </div>

      <div class="relative">
        <div
          #scroller
          (scroll)="onScroll()"
          class="h-[28rem] overflow-auto px-3 py-2.5 font-mono text-[12.5px] leading-[21px]"
          tabindex="0"
          role="log"
          aria-label="Preview log"
          data-testid="log"
        >
          @if (dropped() > 0) {
            <p class="opacity-40" data-testid="dropped">
              … {{ dropped() }} older lines dropped from this tab
            </p>
          }
          @for (l of visible(); track l.n) {
            <div
              class="flex gap-3.5 [contain-intrinsic-size:auto_1.25rem] [content-visibility:auto]"
              data-testid="line"
            >
              <span class="w-10 shrink-0 text-right opacity-40 select-none">{{ l.n }}</span>
              <span class="break-all whitespace-pre-wrap" [class]="cls[l.stream]">{{
                l.line
              }}</span>
            </div>
          } @empty {
            <p class="py-8 text-center opacity-50" data-testid="log-empty">
              {{ status() === 'live' ? 'Nothing logged yet.' : 'Connecting…' }}
            </p>
          }
        </div>
        @if (!stuck()) {
          <button
            type="button"
            (click)="jump()"
            data-testid="jump"
            class="absolute right-4 bottom-3 bg-flag px-3 py-1 text-[11px] font-semibold tracking-[.12em] text-flag-fg uppercase shadow-lg"
          >
            ↓ Jump to latest
          </button>
        }
      </div>
    </div>
  `,
})
export class LogViewer {
  readonly previewId = input.required<string>();
  readonly follow = input(true);

  readonly #sse = inject(SseService);
  readonly #frame = inject(FRAME);
  private readonly scroller = viewChild.required<ElementRef<HTMLElement>>('scroller');

  protected readonly filters = ['all', ...LOG_STREAMS] as const;
  protected readonly cls = STREAM_CLASS;
  protected readonly filter = signal<(typeof this.filters)[number]>('all');
  protected readonly stuck = signal(true);

  readonly #buffer = new LogBuffer();
  readonly #version = signal(0);
  readonly #handle = signal<SseHandle | null>(null);
  #pending: LogLine[] = [];
  #scheduled = false;

  protected readonly status = computed(() => this.#handle()?.status() ?? 'idle');
  protected readonly dropped = computed(() => {
    this.#version();
    return this.#buffer.dropped;
  });
  protected readonly visible = computed(() => {
    this.#version();
    const f = this.filter();
    return f === 'all' ? this.#buffer.lines : this.#buffer.lines.filter((l) => l.stream === f);
  });

  constructor() {
    effect(() => {
      const id = this.previewId();
      const follow = this.follow();
      untracked(() => {
        this.#handle()?.close();
        this.#handle.set(
          follow
            ? this.#sse.open<Omit<LogLine, 'n'>>(
                `/v1/previews/${id}/logs?tail=${TAIL}`,
                ['log'],
                (m) => this.#receive({ ...m.data, n: Number(m.id) }),
              )
            : null,
        );
      });
    });
    effect(() => {
      this.visible();
      if (untracked(this.stuck)) this.#frame(() => this.#toBottom());
    });
    inject(DestroyRef).onDestroy(() => this.#handle()?.close());
  }

  #receive(line: LogLine): void {
    this.#pending.push(line);
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#frame(() => {
      this.#scheduled = false;
      const batch = this.#pending;
      this.#pending = [];
      if (this.#buffer.push(batch)) this.#version.update((v) => v + 1);
    });
  }

  protected onScroll(): void {
    this.stuck.set(isStuckToBottom(this.scroller().nativeElement));
  }

  protected jump(): void {
    this.stuck.set(true);
    this.#toBottom();
  }

  #toBottom(): void {
    const el = this.scroller().nativeElement;
    el.scrollTop = el.scrollHeight;
  }
}
