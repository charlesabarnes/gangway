import { Component, ElementRef, computed, input, output, signal, viewChild } from '@angular/core';
import { Btn } from './button';

/**
 * A native <dialog>. `showModal()` gives the things a hand-rolled modal gets wrong for
 * free: focus is trapped, Esc cancels, the page behind is inert, and focus returns to
 * whatever opened it. Focus starts on CANCEL -- this is only used for destructive things,
 * and Enter on a reflex must not destroy anything.
 *
 * `phrase`, for a one-way door (§10.5.1): Confirm stays disabled until it is typed exactly.
 */
@Component({
  selector: 'app-confirm-dialog',
  imports: [Btn],
  template: `
    <!-- A native <dialog> closes on Escape; the click only handles the backdrop. -->
    <!-- eslint-disable-next-line @angular-eslint/template/click-events-have-key-events, @angular-eslint/template/interactive-supports-focus -->
    <dialog #dialog (close)="closed()" (click)="backdrop($event)"
            class="m-auto w-full max-w-md rounded-xl border border-neutral-200 bg-white p-0 text-neutral-900 shadow-2xl backdrop:bg-neutral-950/50 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100"
            aria-labelledby="confirm-heading" data-testid="confirm">
      <div class="p-6">
        <h2 id="confirm-heading" class="text-base font-semibold">{{ heading() }}</h2>
        <div class="mt-2 text-sm text-neutral-600 dark:text-neutral-400"><ng-content /></div>
        @if (phrase(); as p) {
          <label class="mt-4 block text-sm">Type <span class="font-mono font-semibold">{{ p }}</span> to confirm
            <input type="text" autocomplete="off" spellcheck="false" [value]="typed()" (input)="typed.set($any($event.target).value)" (keydown.enter)="$event.preventDefault()"
                   class="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-950" data-testid="confirm-phrase" />
          </label>
        }
        <div class="mt-6 flex justify-end gap-2">
          <button #cancel appBtn variant="ghost" type="button" (click)="dialog.close('cancel')" data-testid="confirm-cancel">Cancel</button>
          <button appBtn variant="danger" type="button" [disabled]="!ready()" (click)="dialog.close('confirm')" data-testid="confirm-ok">{{ confirmLabel() }}</button>
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
  protected readonly ready = computed(() => { const p = this.phrase(); return p === null || this.typed() === p; });

  // `viewChild` cannot sit on an ES #private member (NG1053), hence TypeScript `private`.
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
    if (this.dialogRef().nativeElement.returnValue === 'confirm' && this.ready()) this.confirmed.emit();
  }

  /** A click on the backdrop lands on the <dialog> itself; one inside lands on a child. */
  protected backdrop(e: MouseEvent): void {
    if (e.target === this.dialogRef().nativeElement) this.dialogRef().nativeElement.close('cancel');
  }
}
