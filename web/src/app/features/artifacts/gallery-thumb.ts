import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  input,
  signal,
} from '@angular/core';
import { FrameQueue } from '../../ui/frame-queue';
import { NearViewport } from '../../ui/near-viewport';
import { SafeFramePipe } from '../../ui/safe-frame.pipe';

const W = 1280;
const H = 800;

/** A live artifact, drawn at a desktop width and scaled to its card: loaded near view, a few at a time. */
@Component({
  selector: 'app-gallery-thumb',
  imports: [NearViewport, SafeFramePipe],
  host: { class: 'absolute inset-0 block' },
  template: `
    <div class="absolute inset-0" (appNearViewport)="start()">
      @if (!loaded()) {
        <div class="gw-skeleton absolute inset-0" data-testid="thumb-loading"></div>
      }
      @if (src(); as s) {
        <iframe
          [src]="s | safeFrame"
          [title]="label()"
          tabindex="-1"
          sandbox="allow-scripts allow-same-origin"
          class="pointer-events-none absolute top-0 left-0 origin-top-left border-0 transition-opacity duration-300 motion-reduce:transition-none"
          [class.opacity-0]="!loaded()"
          [style.width.px]="w"
          [style.height.px]="h"
          [style.transform]="'scale(' + scale() + ')'"
          (load)="loadedNow()"
        ></iframe>
      }
    </div>
  `,
})
export class GalleryThumb {
  readonly url = input.required<string>();
  readonly label = input('');
  protected readonly w = W;
  protected readonly h = H;
  protected readonly src = signal<string | null>(null);
  protected readonly loaded = signal(false);
  protected readonly scale = signal(0.25);
  readonly #queue = inject(FrameQueue);
  #release: (() => void) | null = null;
  #destroyed = false;

  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const destroy = inject(DestroyRef);
    destroy.onDestroy(() => {
      this.#destroyed = true;
      this.#release?.();
    });
    afterNextRender(() => {
      const fit = () => this.scale.set(el.clientWidth / W || 0.25);
      fit();
      const ro = new ResizeObserver(fit);
      ro.observe(el);
      destroy.onDestroy(() => ro.disconnect());
    });
  }

  protected async start(): Promise<void> {
    // Only an https preview is framed (SafeFramePipe); anything else stays a plain card.
    if (!this.url().startsWith('https://')) return this.loaded.set(true);
    const release = await this.#queue.acquire();
    if (this.#destroyed) return release();
    this.#release = release;
    this.src.set(this.url());
  }

  protected loadedNow(): void {
    this.loaded.set(true);
    this.#release?.();
    this.#release = null;
  }
}
