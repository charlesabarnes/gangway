import { Component, computed, input, model, output, signal } from '@angular/core';
import type { ThemeToken, TokenMap } from '../../core/artifacts.types';
import { hexOf } from './theme-tokens';
import { brandPalette, type PaperTone } from './palette';
import { readability } from './readability';
import { TokenEditor } from './token-editor';

type Mode = 'light' | 'dark';
type Tokens = { light: TokenMap; dark: TokenMap };

/**
 * A theme's colours the short way: a brand colour, a highlight and a paper, from which every
 * colour for light and dark is derived; what fails to read is listed; all 24 are a click away.
 */
@Component({
  selector: 'app-colour-editor',
  imports: [TokenEditor],
  host: { class: 'grid gap-4' },
  template: `
    <span class="gw-label">Colours</span>
    @if (!readonly()) {
      <div class="grid gap-2.5" data-testid="brand-colours">
        @for (b of brandRows; track b.key) {
          <div class="flex items-center gap-2.5 text-sm">
            <span
              class="relative size-7 shrink-0 shadow-[inset_0_0_0_1px_var(--gw-rule)]"
              [style.background]="shown(b.key)"
            >
              <input
                type="color"
                class="absolute inset-0 size-full cursor-pointer opacity-0"
                [value]="hex(b.key)"
                (input)="pick(b.key, $any($event.target).value)"
                [attr.aria-label]="b.label"
              />
            </span>
            <span class="w-24 shrink-0">{{ b.label }}</span>
            <input
              class="min-w-0 flex-1 border-0 border-b border-rule bg-transparent px-0 py-1 font-mono text-xs focus:border-ink focus:outline-none"
              [value]="hex(b.key)"
              [attr.aria-label]="b.label + ' value'"
              (change)="pick(b.key, $any($event.target).value)"
              [attr.data-testid]="'brand-' + b.key"
            />
            @if (b.key === 'accent' && accent()) {
              <button type="button" class="gw-action" (click)="pick('accent', '')">Auto</button>
            }
          </div>
        }
        <div class="flex items-center gap-3 text-sm">
          <span class="w-[8.1rem] shrink-0">Paper</span>
          @for (p of papers; track p) {
            <button
              type="button"
              class="gw-action"
              [class.!text-ink]="paper() === p"
              (click)="setPaper(p)"
              [attr.data-testid]="'paper-' + p"
            >
              {{ p }}
            </button>
          }
        </div>
        @if (note()) {
          <p class="m-0 text-xs" data-testid="brand-note">{{ note() }}</p>
        }
        <p class="m-0 text-xs text-muted">
          Every colour below follows these, light and dark; change one and they are made again.
        </p>
      </div>
    }

    <div class="grid gap-1.5" data-testid="readability">
      @if (findings().length === 0) {
        <span class="text-sm text-muted">✓ Every text colour reads clearly, light and dark.</span>
      } @else {
        @for (f of findings(); track f.mode + f.fg + f.bg) {
          <span class="text-sm">
            <span class="text-warn">▲</span> {{ f.what }} ({{ f.mode }}):
            <span class="font-mono text-xs">{{ f.ratio.toFixed(1) }}:1</span>,
            <span class="text-muted">needs {{ f.min }}:1</span>
          </span>
        }
      }
    </div>

    <div class="grid gap-3">
      <button
        type="button"
        class="gw-action justify-self-start"
        (click)="all.set(!all())"
        [attr.aria-expanded]="all()"
        data-testid="all-colours"
      >
        {{ all() ? 'Hide' : 'All' }} 24 colours
      </button>
      @if (all()) {
        <app-token-editor
          [tokens]="tokens()"
          [house]="house()"
          [readonly]="readonly()"
          [(mode)]="mode"
          (changed)="changed.emit($event)"
        />
      }
    </div>
  `,
})
export class ColourEditor {
  readonly tokens = input.required<Tokens>();
  readonly house = input<Record<Mode, Record<ThemeToken, string>> | null>(null);
  readonly readonly = input(false);
  readonly mode = model<Mode>('light');
  readonly changed = output<Tokens>();

  protected readonly brandRows = [
    { key: 'brand', label: 'Brand colour' },
    { key: 'accent', label: 'Highlight' },
  ] as const;
  protected readonly papers: PaperTone[] = ['white', 'tinted', 'warm'];
  protected readonly paper = signal<PaperTone>('tinted');
  // The highlight the user chose; null follows the brand colour.
  protected readonly accent = signal<string | null>(null);
  protected readonly all = signal(false);
  protected readonly note = signal('');
  protected readonly findings = computed(() =>
    readability(this.tokens(), this.house() ?? { light: {}, dark: {} }),
  );

  /** What the row shows: the theme's own value, else gangway's. */
  protected shown(k: 'brand' | 'accent'): string {
    const t: ThemeToken = k === 'brand' ? 'primary' : 'flag';
    return this.tokens().light[t] ?? this.house()?.light[t] ?? '';
  }

  protected hex(k: 'brand' | 'accent'): string {
    return hexOf(this.shown(k));
  }

  protected pick(k: 'brand' | 'accent', v: string): void {
    if (k === 'accent') this.accent.set(v.trim() || null);
    const brand = k === 'brand' ? v : this.hex('brand');
    this.#derive(brand);
  }

  protected setPaper(p: PaperTone): void {
    this.paper.set(p);
    this.#derive(this.hex('brand'));
  }

  #derive(brand: string): void {
    const next = brandPalette(brand, this.accent(), this.paper());
    if (!next) return;
    this.note.set(
      next.light.primary === brand.trim()
        ? ''
        : `${brand} is too light for text and links on the page, so it is the highlight and a deeper shade of it leads.`,
    );
    this.changed.emit(next);
  }
}
