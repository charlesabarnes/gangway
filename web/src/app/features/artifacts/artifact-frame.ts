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

export const FRAME_SRC = '/_gangway/frame.html';

/**
 * An artifact drawn live by the kit, from files that need not be saved anywhere. The page sits
 * in a sandboxed frame with no origin; a new frame is drawn behind the old one and swapped in
 * when ready, so typing does not flicker. It is drawn at `width` and scaled to fit the box.
 */
@Component({
  selector: 'app-artifact-frame',
  host: { class: 'block' },
  template: `
    <div
      #box
      class="relative overflow-hidden bg-paper"
      [style.height.px]="height() ? boxHeight() : null"
      [class.h-full]="!height()"
      data-testid="artifact-frame"
    ></div>
  `,
})
export class ArtifactFrame {
  /** artifact.md and the files beside it. */
  readonly files = input.required<Record<string, string>>();
  readonly themeCss = input('');
  readonly mode = input<'light' | 'dark'>('light');
  /** The width the page is drawn at before scaling; 0 draws it at the box's own size. */
  readonly width = input(1280);
  /** The height it is drawn at; 0 fills the box. */
  readonly height = input(0);
  readonly interactive = input(false);
  /** Show the kit's own theme toggle. */
  readonly chrome = input(false);
  readonly hash = input('');

  private readonly box = viewChild.required<ElementRef<HTMLDivElement>>('box');
  protected readonly boxHeight = signal(0);
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
    });
    afterNextRender(() => {
      const ro = new ResizeObserver(() => this.#fit());
      ro.observe(this.box().nativeElement);
      destroy.onDestroy(() => ro.disconnect());
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

  #schedule(state: object): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#draw(state), this.#current ? 300 : 0);
  }

  #draw(state: object): void {
    const box = this.box().nativeElement;
    const f = document.createElement('iframe');
    f.dataset['gen'] = String(++this.#drawn);
    f.src = FRAME_SRC;
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('title', 'Artifact preview');
    f.style.cssText = 'position:absolute;top:0;left:0;border:0;transform-origin:0 0;opacity:0';
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
    for (const old of frames) if (old !== f) old.remove();
    this.#current = f;
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
    const box = this.box().nativeElement;
    if (this.height())
      this.boxHeight.set((box.clientWidth / (this.width() || box.clientWidth)) * this.height());
    for (const f of box.querySelectorAll('iframe')) this.#size(f);
  }
}
