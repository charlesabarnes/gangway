import { Component, computed, input, output, signal } from '@angular/core';
import { FONTS } from './theme-css';

type Slot = 'serif' | 'sans' | 'mono' | 'display';

// What each slot's sample says: body text for serif and sans, code for mono, a title for display.
const SAMPLE: Record<Slot, string> = {
  serif: 'The quick brown fox jumps over the lazy dog.',
  sans: 'The quick brown fox jumps over the lazy dog.',
  mono: 'const total = 1_840; // ▼ 57%',
  display: 'Quarterly review',
};
// gangway's own face for each slot, shown as the first choice.
const HOUSE: Record<Slot, string> = {
  serif: FONTS.serif['plex-serif']!,
  sans: FONTS.sans['plex-sans-condensed']!,
  mono: FONTS.mono['plex-mono']!,
  display: FONTS.serif['plex-serif']!,
};

const HOUSE_NAME: Record<Slot, string> = {
  serif: 'IBM Plex Serif',
  sans: 'IBM Plex Sans Condensed',
  mono: 'IBM Plex Mono',
  display: 'The serif',
};

/** A font slot as the fonts themselves: the current one in its face, the others a click away. */
@Component({
  selector: 'app-font-picker',
  host: { class: 'grid gap-2' },
  template: `
    <div class="flex items-center justify-between gap-3 text-sm">
      <span class="text-muted">{{ label() }}</span>
      <button
        type="button"
        class="flex max-w-60 min-w-0 items-baseline gap-2 text-left disabled:cursor-default"
        [disabled]="readonly()"
        (click)="open.set(!open())"
        [attr.aria-expanded]="open()"
        [attr.data-testid]="'font-' + slot()"
      >
        <span class="truncate text-lg leading-tight" [style.font-family]="stackOf(value())">{{
          nameOf(value())
        }}</span>
        @if (!readonly()) {
          <span class="gw-action shrink-0">{{ open() ? 'Close' : 'Change' }}</span>
        }
      </button>
    </div>
    @if (open()) {
      <div class="grid gap-1.5" role="radiogroup" [attr.aria-label]="label()">
        @for (c of options(); track c) {
          <button
            type="button"
            role="radio"
            class="grid gap-0.5 px-3 py-2 text-left shadow-[inset_0_0_0_1px_var(--gw-rule)] hover:shadow-[inset_0_0_0_1px_var(--gw-ink)]"
            [class.!shadow-[inset_0_0_0_2px_var(--gw-ink)]]="(value() ?? '') === c"
            [attr.aria-checked]="(value() ?? '') === c"
            (click)="choose(c)"
            [attr.data-testid]="'font-' + slot() + '-' + (c || 'house')"
          >
            <span class="text-[11px] tracking-[.14em] text-muted uppercase">{{ nameOf(c) }}</span>
            <span
              class="truncate leading-snug"
              [class.text-2xl]="slot() === 'display'"
              [class.text-lg]="slot() !== 'display'"
              [style.font-family]="stackOf(c)"
              >{{ sample() }}</span
            >
          </button>
        }
      </div>
    }
  `,
})
export class FontPicker {
  readonly slot = input.required<Slot>();
  readonly label = input.required<string>();
  readonly choices = input.required<string[]>();
  readonly labels = input<Record<string, string>>({});
  readonly value = input<string | undefined>(undefined);
  readonly readonly = input(false);
  /** The chosen key; '' is gangway's own. */
  readonly changed = output<string>();
  protected readonly open = signal(false);
  protected readonly options = computed(() => ['', ...this.choices()]);
  protected readonly sample = computed(() => SAMPLE[this.slot()]);

  protected nameOf(key: string | undefined): string {
    return key ? (this.labels()[key] ?? key) : `${HOUSE_NAME[this.slot()]} (default)`;
  }

  protected stackOf(key: string | undefined): string {
    return (key && FONTS[this.slot()][key]) || HOUSE[this.slot()];
  }

  protected choose(key: string): void {
    this.changed.emit(key);
    this.open.set(false);
  }
}
