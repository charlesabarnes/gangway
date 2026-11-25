import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  effect,
  inject,
  input,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';

export type Choice = { readonly value: string; readonly label: string };

const LINK =
  'text-[13px] text-muted underline underline-offset-2 hover:text-ink disabled:opacity-50';

/** A link that opens to a few choices in a row; picking one runs `pick` and closes on true. */
@Component({
  selector: 'app-choice-link',
  host: {
    class: 'inline-flex flex-wrap items-baseline gap-x-2.5 gap-y-1',
    '(keydown.escape)': 'close()',
  },
  template: `
    @if (open()) {
      <span class="text-[13px] text-muted" [id]="name() + '-prompt'">{{ prompt() }}</span>
      @for (c of choices(); track c.value) {
        <button
          #choice
          type="button"
          [class]="link"
          [disabled]="saving()"
          (click)="choose(c.value)"
          [attr.aria-describedby]="name() + '-prompt'"
          [attr.data-testid]="name() + '-' + c.value"
        >
          {{ c.label }}
        </button>
      }
      <button
        type="button"
        class="text-[13px] text-muted hover:text-ink"
        aria-label="Cancel"
        (click)="close()"
        [attr.data-testid]="name() + '-cancel'"
      >
        ✕
      </button>
    } @else {
      <button
        #toggle
        type="button"
        [class]="link"
        aria-expanded="false"
        (click)="open.set(true)"
        [attr.data-testid]="toggleId() ?? name()"
      >
        {{ label() }}
      </button>
    }
  `,
})
export class ChoiceLink {
  readonly name = input.required<string>();
  readonly label = input.required<string>();
  readonly prompt = input.required<string>();
  readonly choices = input.required<readonly Choice[]>();
  readonly pick = input.required<(value: string) => Promise<boolean>>();
  readonly toggleId = input<string>();

  readonly #injector = inject(Injector);
  protected readonly link = LINK;
  protected readonly open = signal(false);
  protected readonly saving = signal(false);
  private readonly choiceEls = viewChildren<ElementRef<HTMLButtonElement>>('choice');
  private readonly toggleEl = viewChild<ElementRef<HTMLButtonElement>>('toggle');

  constructor() {
    effect(() => {
      if (this.open()) this.choiceEls()[0]?.nativeElement.focus();
    });
  }

  protected close(): void {
    if (!this.open()) return;
    this.open.set(false);
    afterNextRender(() => this.toggleEl()?.nativeElement.focus(), { injector: this.#injector });
  }

  protected async choose(value: string): Promise<void> {
    this.saving.set(true);
    try {
      if (await this.pick()(value)) this.close();
    } finally {
      this.saving.set(false);
    }
  }
}
