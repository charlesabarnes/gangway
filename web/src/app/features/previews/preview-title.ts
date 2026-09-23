import { Component, computed, inject, input, signal } from '@angular/core';
import type { Preview } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import type { ProblemError } from '../../core/problem';
import { Btn } from '../../ui/button';
import { FIELD } from '../../ui/field';
import { ToastService } from '../../ui/toast';
import { PreviewsStore } from './previews.store';
import { displayName, slugOf } from './source-label';

@Component({
  selector: 'app-preview-title',
  imports: [Btn],
  host: { class: 'flex min-w-0 flex-col gap-1.5' },
  template: `
    @if (editing()) {
      <form
        class="flex flex-wrap items-center gap-3"
        (submit)="$event.preventDefault(); save()"
        (keydown.escape)="editing.set(false)"
      >
        <input
          [class]="field + ' min-w-64 text-2xl'"
          maxlength="100"
          aria-label="Name"
          [placeholder]="slug()"
          [value]="draft()"
          (input)="draft.set($any($event.target).value)"
          data-testid="title-input"
        />
        <button appBtn size="sm" type="submit" [disabled]="busy()" data-testid="title-save">
          Save
        </button>
        <button appBtn variant="ghost" size="sm" type="button" (click)="editing.set(false)">
          Cancel
        </button>
      </form>
      <span class="text-xs text-muted">Leave it empty to show the address instead.</span>
    } @else {
      <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1
          class="m-0 font-serif text-[40px] leading-none font-normal tracking-[-.01em] break-words sm:text-[52px]"
          data-testid="title"
        >
          {{ name() }}
        </h1>
        @if (canRename()) {
          <button
            type="button"
            class="text-xs font-semibold tracking-[.1em] text-muted uppercase hover:text-ink"
            (click)="edit()"
            data-testid="rename"
          >
            Rename
          </button>
        }
      </div>
      @if (preview().title) {
        <span class="font-mono text-[13px] text-muted" data-testid="slug">{{ slug() }}</span>
      }
    }
  `,
})
export class PreviewTitle {
  readonly preview = input.required<Preview>();

  readonly #store = inject(PreviewsStore);
  readonly #auth = inject(AuthService);
  readonly #toasts = inject(ToastService);

  protected readonly field = FIELD;
  protected readonly name = computed(() => displayName(this.preview()));
  protected readonly slug = computed(() => slugOf(this.preview()));
  protected readonly canRename = computed(
    () =>
      this.preview().state !== 'destroyed' &&
      (this.#auth.can('previews.update') || this.#auth.can('previews.update_own')),
  );
  protected readonly editing = signal(false);
  protected readonly draft = signal('');
  protected readonly busy = signal(false);

  protected edit(): void {
    this.draft.set(this.preview().title ?? '');
    this.editing.set(true);
  }

  protected async save(): Promise<void> {
    const title = this.draft().trim() || null;
    this.busy.set(true);
    try {
      await this.#store.setTitle(this.preview().id, title);
      this.editing.set(false);
    } catch (e) {
      this.#toasts.problem('Could not rename it', e as ProblemError);
    } finally {
      this.busy.set(false);
    }
  }
}
