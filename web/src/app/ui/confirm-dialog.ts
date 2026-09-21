import { Component, ElementRef, input, output, viewChild } from '@angular/core';
import { Btn } from './button';

/**
 * A native <dialog>. `showModal()` gives the things a hand-rolled modal gets wrong for
 * free: focus is trapped, Esc cancels, the page behind is inert, and focus returns to
 * whatever opened it. Focus starts on CANCEL -- this is only used for destructive things,
 * and Enter on a reflex must not destroy anything.
 */
@Component({
  selector: 'app-confirm-dialog',
  imports: [Btn],
  template: `
    <dialog #dialog (close)="closed()" (click)="backdrop($event)"
            class="m-auto w-full max-w-md rounded-xl border border-neutral-200 bg-white p-0 text-neutral-900 shadow-2xl backdrop:bg-neutral-950/50 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100"
            aria-labelledby="confirm-heading" data-testid="confirm">
      <div class="p-6">
        <h2 id="confirm-heading" class="text-base font-semibold">{{ heading() }}</h2>
        <div class="mt-2 text-sm text-neutral-600 dark:text-neutral-400"><ng-content /></div>
        <div class="mt-6 flex justify-end gap-2">
          <button #cancel appBtn variant="ghost" type="button" (click)="dialog.close('cancel')" data-testid="confirm-cancel">Cancel</button>
          <button appBtn variant="danger" type="button" (click)="dialog.close('confirm')" data-testid="confirm-ok">{{ confirmLabel() }}</button>
        </div>
      </div>
    </dialog>
  `,
})
export class ConfirmDialog {
  readonly heading = input.required<string>();
  readonly confirmLabel = input('Confirm');
  readonly confirmed = output<void>();

  // `viewChild` cannot sit on an ES #private member (NG1053), hence TypeScript `private`.
  private readonly dialogRef = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly cancelRef = viewChild.required<ElementRef<HTMLButtonElement>>('cancel');

  open(): void {
    const d = this.dialogRef().nativeElement;
    d.returnValue = '';
    d.showModal();
    this.cancelRef().nativeElement.focus();
  }

  protected closed(): void {
    if (this.dialogRef().nativeElement.returnValue === 'confirm') this.confirmed.emit();
  }

  /** A click on the backdrop lands on the <dialog> itself; one inside lands on a child. */
  protected backdrop(e: MouseEvent): void {
    if (e.target === this.dialogRef().nativeElement) this.dialogRef().nativeElement.close('cancel');
  }
}
