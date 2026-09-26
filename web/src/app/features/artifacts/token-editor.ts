import { Component, input, model, output } from '@angular/core';
import { TOKEN_LABELS, type ThemeToken, type TokenMap } from '../../core/artifacts.types';
import { GROUPS, hexOf } from './theme-tokens';

type Mode = 'light' | 'dark';
type Tokens = { light: TokenMap; dark: TokenMap };

/** A theme's colours, light or dark: a swatch to pick with, the value to type, the house value to fall back on. */
@Component({
  selector: 'app-token-editor',
  host: { class: 'grid gap-3' },
  template: `
    <div class="flex items-center gap-4">
      <span class="gw-label">Colours</span>
      <div class="ml-auto flex gap-3" role="group" aria-label="Mode">
        @for (m of modes; track m) {
          <button
            type="button"
            class="gw-action"
            [class.!text-ink]="mode() === m"
            (click)="mode.set(m)"
            [attr.data-testid]="'mode-' + m"
          >
            {{ m }}
          </button>
        }
      </div>
    </div>
    @for (g of groups; track g.title) {
      <div class="grid gap-1.5">
        <span class="text-xs text-muted">{{ g.title }}</span>
        @for (tk of g.tokens; track tk) {
          <div class="flex items-center gap-2.5 text-sm" [attr.data-testid]="'token-' + tk">
            <span
              class="relative size-7 shrink-0 shadow-[inset_0_0_0_1px_var(--gw-rule)]"
              [style.background]="current(tk)"
            >
              <input
                type="color"
                class="absolute inset-0 size-full cursor-pointer opacity-0"
                [disabled]="readonly()"
                [value]="hex(tk)"
                (input)="set(tk, $any($event.target).value)"
                [attr.aria-label]="labels[tk]"
              />
            </span>
            <span class="w-32 shrink-0">{{ labels[tk] }}</span>
            <input
              class="min-w-0 flex-1 border-0 border-b border-rule bg-transparent px-0 py-1 font-mono text-xs focus:border-ink focus:outline-none"
              [disabled]="readonly()"
              [value]="tokens()[mode()][tk] ?? ''"
              [placeholder]="fallback(tk)"
              [attr.aria-label]="labels[tk] + ' value'"
              (change)="set(tk, $any($event.target).value)"
            />
          </div>
        }
      </div>
    }
  `,
})
export class TokenEditor {
  readonly tokens = input.required<Tokens>();
  readonly house = input<Record<Mode, Record<ThemeToken, string>> | null>(null);
  readonly readonly = input(false);
  readonly mode = model<Mode>('light');
  readonly changed = output<Tokens>();
  protected readonly labels = TOKEN_LABELS;
  protected readonly groups = GROUPS;
  protected readonly modes: Mode[] = ['light', 'dark'];

  protected fallback(tk: ThemeToken): string {
    return this.house()?.[this.mode()][tk] ?? '';
  }

  protected current(tk: ThemeToken): string {
    return this.tokens()[this.mode()][tk] ?? this.fallback(tk);
  }

  protected hex(tk: ThemeToken): string {
    return hexOf(this.current(tk));
  }

  protected set(tk: ThemeToken, v: string): void {
    const m = this.mode();
    const t = this.tokens();
    const next = { ...t[m] };
    if (v.trim()) next[tk] = v.trim();
    else delete next[tk];
    this.changed.emit({ ...t, [m]: next });
  }
}
