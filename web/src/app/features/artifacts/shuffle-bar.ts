import { Component, output, signal } from '@angular/core';
import { Btn } from '../../ui/button';
import { randomTheme, type RandomTheme } from './theme-random';

type Part = 'colours' | 'type' | 'shape';
export type Shuffle = Partial<Pick<RandomTheme, 'tokens' | 'fonts' | 'style'>> & { name: string };

/** Random look, with the parts to keep as they are. */
@Component({
  selector: 'app-shuffle-bar',
  imports: [Btn],
  host: { class: 'flex flex-wrap items-center gap-3' },
  template: `
    <span class="gw-action !cursor-default">Keep</span>
    @for (p of parts; track p) {
      <button
        type="button"
        class="gw-action"
        [class.!text-ink]="kept().has(p)"
        [attr.aria-pressed]="kept().has(p)"
        (click)="toggle(p)"
        [attr.data-testid]="'keep-' + p"
      >
        {{ kept().has(p) ? '■' : '□' }} {{ p }}
      </button>
    }
    <button
      appBtn
      variant="ghost"
      type="button"
      [disabled]="kept().size === parts.length"
      (click)="shuffle()"
      title="A new look: type, shape and colours chosen to go together"
      data-testid="random-theme"
    >
      Random look
    </button>
  `,
})
export class ShuffleBar {
  readonly shuffled = output<Shuffle>();
  protected readonly parts: Part[] = ['colours', 'type', 'shape'];
  protected readonly kept = signal(new Set<Part>());
  // The look the last shuffle landed on, so the next is a different one.
  #look: string | undefined;

  protected toggle(p: Part): void {
    this.kept.update((k) => {
      const next = new Set(k);
      if (!next.delete(p)) next.add(p);
      return next;
    });
  }

  /** A new look for every part not kept. */
  shuffle(): void {
    const k = this.kept();
    const t = randomTheme(Math.random, this.#look);
    // Only the colours new: the look is still the last one, and so is the name's first word.
    const recolour = k.has('type') && k.has('shape') && this.#look;
    if (!recolour) this.#look = t.look;
    this.shuffled.emit({
      name: recolour ? `${this.#look} ${t.name.split(' ').pop()}` : t.name,
      ...(k.has('colours') ? {} : { tokens: t.tokens }),
      ...(k.has('type') ? {} : { fonts: t.fonts }),
      ...(k.has('shape') ? {} : { style: t.style }),
    });
  }
}
