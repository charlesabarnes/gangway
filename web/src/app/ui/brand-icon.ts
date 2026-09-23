import { Component, computed, input } from '@angular/core';

/**
 * A brand mark (Simple Icons, CC0): one 24×24 path, in its colour -- or the text colour for
 * black marks. In dark mode a colour is lifted toward white: MySQL's and Python's blues
 * are made for white paper and all but vanish on neutral-950.
 */
@Component({
  selector: 'app-brand-icon',
  template: `<svg
    viewBox="0 0 24 24"
    [attr.width]="size()"
    [attr.height]="size()"
    aria-hidden="true"
    focusable="false"
  >
    <path [attr.d]="path()" [style.fill]="fill()" />
  </svg>`,
  host: { class: 'inline-flex shrink-0' },
})
export class BrandIcon {
  readonly path = input.required<string>();
  /** `#rrggbb`, or null for the current text colour. */
  readonly color = input<string | null>(null);
  readonly size = input(20);
  protected readonly fill = computed(() => {
    const c = this.color();
    return c ? `light-dark(${c}, color-mix(in oklch, ${c} 70%, white))` : 'currentColor';
  });
}
