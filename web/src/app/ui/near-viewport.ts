import { Directive, ElementRef, afterNextRender, inject, output, DestroyRef } from '@angular/core';

/** Emits once, when the element comes within `200px` of the viewport. */
@Directive({ selector: '[appNearViewport]' })
export class NearViewport {
  readonly appNearViewport = output<void>();

  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const destroy = inject(DestroyRef);
    afterNextRender(() => {
      if (typeof IntersectionObserver === 'undefined') {
        this.appNearViewport.emit();
        return;
      }
      const io = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          io.disconnect();
          this.appNearViewport.emit();
        },
        { rootMargin: '200px' },
      );
      io.observe(el);
      destroy.onDestroy(() => io.disconnect());
    });
  }
}
