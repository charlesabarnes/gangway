import { Component, ElementRef, computed, input, output, signal, viewChild } from '@angular/core';
import { Btn } from './button';

@Component({
  selector: 'app-confirm-dialog',
  imports: [Btn],
  template: `
    <!-- A native <dialog> closes on Escape; the click only handles the backdrop. -->
    <!-- eslint-disable-next-line @angular-eslint/template/click-events-have-key-events, @angular-eslint/template/interactive-supports-focus -->
    <dialog
      #dialog
      (close)="closed()"
      (click)="backdrop($event)"
      class="gw-neatline-strong m-auto w-full max-w-md border-0 bg-paper p-0 text-ink backdrop:bg-header/60"
      aria-labelledby="confirm-heading"
      data-testid="confirm"
    >
      <div class="p-8">
        <h2 id="confirm-heading" class="gw-h2">{{ heading() }}</h2>
        <div class="mt-2 text-sm text-muted"><ng-content /></div>
        @if (phrase(); as p) {
          <label class="mt-4 block text-sm text-muted"
            >Type <span class="font-mono font-semibold">{{ p }}</span> to confirm
            <input
              type="text"
              autocomplete="off"
              spellcheck="false"
              [value]="typed()"
              (input)="typed.set($any($event.target).value)"
              (keydown.enter)="$event.preventDefault()"
              class="mt-1 block w-full border-0 border-b border-ink bg-transparent px-0 py-[7px] font-mono text-sm text-ink focus:outline-none focus-visible:shadow-[0_2px_0_var(--gw-flag)]"
              data-testid="confirm-phrase"
            />
          </label>
        }
        <div class="mt-6 flex justify-end gap-2">
          <button
            #cancel
            appBtn
            variant="ghost"
            type="button"
            (click)="dialog.close('cancel')"
            data-testid="confirm-cancel"
          >
            Cancel
          </button>
          <button
            appBtn
            variant="danger"
            type="button"
            [disabled]="!ready()"
            (click)="dialog.close('confirm')"
            data-testid="confirm-ok"
          >
            {{ confirmLabel() }}
          </button>
        </div>
      </div>
    </dialog>
  `,
})
export class ConfirmDialog {
  readonly heading = input.required<string>();
  readonly confirmLabel = input('Confirm');
  readonly phrase = input<string | null>(null);
  readonly confirmed = output<void>();

  protected readonly typed = signal('');
  protected readonly ready = computed(() => {
    const p = this.phrase();
    return p === null || this.typed() === p;
  });

  // viewChild cannot target an ES #private field (NG1053).
  private readonly dialogRef = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly cancelRef = viewChild.required<ElementRef<HTMLButtonElement>>('cancel');

  open(): void {
    const d = this.dialogRef().nativeElement;
    d.returnValue = '';
    this.typed.set('');
    d.showModal();
    this.cancelRef().nativeElement.focus();
  }

  protected closed(): void {
    if (this.dialogRef().nativeElement.returnValue === 'confirm' && this.ready())
      this.confirmed.emit();
  }

  protected backdrop(e: MouseEvent): void {
    if (e.target === this.dialogRef().nativeElement) this.dialogRef().nativeElement.close('cancel');
  }
}
