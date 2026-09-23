import { Component, computed, input } from '@angular/core';

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
  readonly color = input<string | null>(null);
  readonly size = input(20);
  protected readonly fill = computed(() => {
    const c = this.color();
    return c ? `light-dark(${c}, color-mix(in oklch, ${c} 70%, white))` : 'currentColor';
  });
}
