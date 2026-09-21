import { Component, DestroyRef, ElementRef, InjectionToken, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { LOG_STREAMS, type LogLine, type LogStream } from '../../core/api.types';
import { SseService, type SseHandle } from '../../core/sse.service';
import { ConnectionDot } from '../../ui/connection-dot';
import { LogBuffer, isStuckToBottom } from './log-buffer';

/** "Once per frame". Injected because jsdom has no requestAnimationFrame, and specs want to choose when. */
export const FRAME = new InjectionToken<(cb: () => void) => void>('FRAME', {
  providedIn: 'root',
  factory: () => (cb: () => void) => { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cb); else setTimeout(cb, 16); },
});

/** How much history to ask for. The server says so, in the stream, when there was more. */
const TAIL = 2_000;

const STREAM_CLASS: Record<LogStream, string> = {
  system: 'text-sky-400', build: 'text-neutral-400', stdout: 'text-neutral-100', stderr: 'text-amber-300',
};

/**
 * A live log. Build output and runtime output are ONE stream on the server, told apart by
 * `stream`, so "the build log" is a filter here and not a second endpoint.
 *
 * A build can emit hundreds of lines a second. Each one is NOT a change-detection pass:
 * lines collect in a plain array and are flushed once per animation frame into one signal
 * write. Rows are `content-visibility: auto`, so the browser skips layout and paint for
 * the thousands that are off-screen -- most of what a virtual scroller buys, with no
 * library and no broken find-in-page.
 */
@Component({
  selector: 'app-log-viewer',
  imports: [ConnectionDot],
  template: `
    <div class="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950">
      <div class="flex flex-wrap items-center gap-1.5 border-b border-neutral-800 px-3 py-2">
        @for (f of filters; track f) {
          <button type="button" (click)="filter.set(f)" [attr.aria-pressed]="filter() === f" [attr.data-testid]="'stream-' + f"
                  class="rounded px-2 py-0.5 text-xs" [class]="filter() === f ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'">{{ f }}</button>
        }
        <span class="ml-auto"><app-connection-dot [status]="status()" /></span>
      </div>

      <div class="relative">
        <div #scroller (scroll)="onScroll()" class="h-[28rem] overflow-auto px-3 py-2 font-mono text-xs leading-5" tabindex="0" role="log" aria-label="Preview log" data-testid="log">
          @if (dropped() > 0) { <p class="text-neutral-600" data-testid="dropped">… {{ dropped() }} older lines dropped from this tab</p> }
          @for (l of visible(); track l.n) {
            <div class="flex gap-3 [contain-intrinsic-size:auto_1.25rem] [content-visibility:auto]" data-testid="line">
              <span class="w-12 shrink-0 text-right text-neutral-600 select-none">{{ l.n }}</span>
              <span class="break-all whitespace-pre-wrap" [class]="cls[l.stream]">{{ l.line }}</span>
            </div>
          } @empty {
            <p class="py-8 text-center text-neutral-600" data-testid="log-empty">{{ status() === 'live' ? 'Nothing logged yet.' : 'Connecting…' }}</p>
          }
        </div>
        @if (!stuck()) {
          <button type="button" (click)="jump()" data-testid="jump"
                  class="absolute right-4 bottom-3 rounded-full bg-accent px-3 py-1 text-xs font-medium text-white shadow-lg">↓ Jump to latest</button>
        }
      </div>
    </div>
  `,
})
export class LogViewer {
  readonly previewId = input.required<string>();
  /** False once the preview is destroyed: its log is deleted server-side, so there is nothing to follow. */
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
  protected readonly dropped = computed(() => { this.#version(); return this.#buffer.dropped; });
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
        this.#handle.set(follow ? this.#sse.open<Omit<LogLine, 'n'>>(`/v1/previews/${id}/logs?tail=${TAIL}`, ['log'], (m) => this.#receive({ ...m.data, n: Number(m.id) })) : null);
      });
    });
    // After the lines are in the DOM, not before: scrollHeight has to include them.
    effect(() => { this.visible(); if (untracked(this.stuck)) this.#frame(() => this.#toBottom()); });
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

  /** Scrolling up to read something must not be yanked back down by the next line. */
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
