import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FrameQueue } from '../../ui/frame-queue';

export const FRAME_SRC = '/_gangway/frame.html';

/** An artifact drawn live in a sandboxed frame; a redraw swaps in when ready, so typing never flickers. */
@Component({
  selector: 'app-artifact-frame',
  host: { class: 'block' },
  template: `
    <div
      #box
      class="relative overflow-hidden bg-paper"
      [style.aspect-ratio]="height() ? width() + ' / ' + height() : null"
      [class.h-full]="!height()"
      data-testid="artifact-frame"
    >
      @if (!shown()) {
        <div class="gw-skeleton absolute inset-0"></div>
      }
    </div>
  `,
})
export class ArtifactFrame {
  readonly files = input.required<Record<string, string>>();
  readonly themeCss = input('');
  readonly mode = input<'light' | 'dark'>('light');
  /** The width the page is drawn at before scaling; 0 draws it at the box's own size. */
  readonly width = input(1280);
  /** The height it is drawn at; 0 fills the box. */
  readonly height = input(0);
  readonly interactive = input(false);
  readonly chrome = input(false);
  readonly hash = input('');
  /** Wait until it is near the viewport, and take a turn in the frame queue, before the first draw. */
  readonly lazy = input(false);

  private readonly box = viewChild.required<ElementRef<HTMLDivElement>>('box');
  protected readonly shown = signal(false);
  readonly #queue = inject(FrameQueue);
  #release: (() => void) | null = null;
  #near = false;
  #pending: object | null = null;
  #current: HTMLIFrameElement | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #scale = 1;
  #drawn = 0;

  constructor() {
    const destroy = inject(DestroyRef);
    const onMessage = (e: MessageEvent) => this.#message(e);
    window.addEventListener('message', onMessage);
    destroy.onDestroy(() => {
      window.removeEventListener('message', onMessage);
      if (this.#timer) clearTimeout(this.#timer);
      this.#release?.();
    });
    afterNextRender(() => {
      const box = this.box().nativeElement;
      const ro = new ResizeObserver(() => this.#fit());
      ro.observe(box);
      destroy.onDestroy(() => ro.disconnect());
      if (!this.lazy() || typeof IntersectionObserver === 'undefined') return this.#arrive();
      const io = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          io.disconnect();
          this.#arrive();
        },
        { rootMargin: '200px' },
      );
      io.observe(box);
      destroy.onDestroy(() => io.disconnect());
    });
    effect(() => {
      const state = {
        files: this.files(),
        themeCss: this.themeCss(),
        mode: this.mode(),
        chrome: this.chrome(),
        hash: this.hash(),
        still: !this.interactive(),
      };
      untracked(() => this.#schedule(state));
    });
  }

  #arrive(): void {
    this.#near = true;
    if (this.#pending) this.#schedule(this.#pending);
  }

  #schedule(state: object): void {
    this.#pending = state;
    if (!this.#near && this.lazy()) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#draw(state), this.#current ? 300 : 0);
  }

  async #draw(state: object): Promise<void> {
    if (this.lazy() && !this.#current && !this.#release) {
      this.#release = await this.#queue.acquire();
      if (state !== this.#pending) return;
    }
    const box = this.box().nativeElement;
    const f = document.createElement('iframe');
    f.dataset['gen'] = String(++this.#drawn);
    f.src = FRAME_SRC;
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('title', 'Artifact preview');
    f.style.cssText =
      'position:absolute;top:0;left:0;border:0;transform-origin:0 0;opacity:0;transition:opacity .25s';
    this.#size(f);
    if (!this.interactive()) f.style.pointerEvents = 'none';
    box.appendChild(f);
    // The frame listens from its first script, so by `load` it will hear the files.
    f.addEventListener('load', () =>
      f.contentWindow?.postMessage({ type: 'gw-render', ...state }, '*'),
    );
  }

  #message(e: MessageEvent): void {
    const data = e.data as { type?: string } | null;
    const frames = [...this.box().nativeElement.querySelectorAll('iframe')];
    const f = frames.find((x) => x.contentWindow === e.source);
    if (!f || !data?.type) return;
    if (data.type !== 'gw-rendered') return;
    // A frame drawn from older inputs that finishes late is dropped, never shown over a newer one.
    if (Number(f.dataset['gen']) !== this.#drawn) {
      if (this.#current) f.remove();
      return;
    }
    f.style.opacity = '1';
    // The old page stays underneath until the new one has faded in and painted: a browser
    // paints a frame it held back while invisible a moment after it shows.
    setTimeout(() => {
      for (const old of frames) if (old !== f && old !== this.#current) old.remove();
    }, 1500);
    this.#current = f;
    this.shown.set(true);
    this.#release?.();
  }

  #size(f: HTMLIFrameElement): void {
    const box = this.box().nativeElement;
    const w = this.width() || box.clientWidth;
    this.#scale = this.width() ? box.clientWidth / this.width() : 1;
    const h = this.height() || box.clientHeight / this.#scale;
    f.style.width = `${w}px`;
    f.style.height = `${h}px`;
    f.style.transform = `scale(${this.#scale})`;
  }

  #fit(): void {
    for (const f of this.box().nativeElement.querySelectorAll('iframe')) this.#size(f);
  }
}
