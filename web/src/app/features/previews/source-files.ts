import { Component, input, output, signal } from '@angular/core';
import { Btn } from '../../ui/button';
import { UploadError } from '../new/pack';
import { formatBytes } from '../new/upload';
import { CodeEditor } from './code-editor';
import type { SourceDraft } from './source-draft';

export const SOURCE_FIELD =
  'rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm focus:border-accent focus:outline-2 focus:outline-accent/30 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900';

@Component({
  selector: 'app-source-files',
  imports: [Btn, CodeEditor],
  host: { class: 'mt-3 grid gap-4 md:grid-cols-4' },
  template: `
    @let d = draft();
    <div class="md:col-span-1">
      <ul
        class="max-h-[28rem] overflow-y-auto rounded-lg border border-neutral-200 text-sm dark:border-neutral-800"
        data-testid="files"
      >
        @for (f of d.entries(); track f.path) {
          <li>
            <button
              type="button"
              (click)="d.selected.set(f.path)"
              [disabled]="!f.editable"
              [title]="f.editable ? f.path : f.path + ' — binary or too large to edit'"
              class="flex w-full items-center gap-2 px-3 py-1.5 text-left disabled:cursor-default"
              [class]="
                d.selected() === f.path
                  ? 'bg-accent/10 text-accent'
                  : f.editable
                    ? 'hover:bg-neutral-100 dark:hover:bg-neutral-800'
                    : 'text-neutral-400'
              "
              data-testid="file"
              [attr.data-path]="f.path"
            >
              <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ f.path }}</span>
              @if (f.status) {
                <span class="text-[10px] text-amber-600 dark:text-amber-400">{{ f.status }}</span>
              }
              @if (!f.editable) {
                <span class="text-[10px]">{{ size(f.size) }}</span>
              }
            </button>
          </li>
        }
      </ul>
      @if (truncated()) {
        <p class="mt-1 text-xs text-neutral-500">Only the first files are listed.</p>
      }
      @if (canUpdate()) {
        <form (submit)="$event.preventDefault(); addFile()" class="mt-3 flex gap-2">
          <input
            [class]="field + ' min-w-0 flex-1 font-mono text-xs'"
            placeholder="new/file.ts"
            [value]="newPath()"
            (input)="newPath.set($any($event.target).value)"
            aria-label="New file path"
            data-testid="new-path"
          />
          <button
            appBtn
            variant="ghost"
            type="submit"
            [disabled]="!newPath().trim()"
            data-testid="add"
          >
            Add
          </button>
        </form>
      }
    </div>

    <div class="md:col-span-3">
      @if (d.selected(); as path) {
        <div class="mb-2 flex items-center gap-2">
          <span
            class="min-w-0 flex-1 truncate font-mono text-xs text-neutral-500"
            data-testid="selected"
            >{{ path }}</span
          >
          @if (canUpdate()) {
            <button
              type="button"
              (click)="rename()"
              class="text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
              data-testid="rename"
            >
              Move to new path
            </button>
            <button
              type="button"
              (click)="d.remove(path)"
              class="text-xs text-neutral-500 hover:text-red-600 dark:hover:text-red-400"
              data-testid="delete"
            >
              Delete
            </button>
          }
        </div>
        @defer (on idle) {
          <app-code-editor
            [path]="path"
            [value]="d.textOf(path)"
            [readonly]="!canUpdate()"
            (changed)="d.edit(path, $event)"
            (save)="save.emit()"
          />
        } @placeholder {
          <div
            class="h-80 rounded-md border border-neutral-300 dark:border-neutral-700"
            data-testid="editor-loading"
          ></div>
        }
      } @else {
        <p
          class="rounded-lg border border-dashed border-neutral-300 px-4 py-10 text-center text-sm text-neutral-500 dark:border-neutral-700"
        >
          Pick a file to edit.
        </p>
      }
    </div>
  `,
})
export class SourceFiles {
  readonly draft = input.required<SourceDraft>();
  readonly canUpdate = input.required<boolean>();
  readonly truncated = input.required<boolean>();
  readonly save = output();
  readonly refused = output<unknown>();

  protected readonly field = SOURCE_FIELD;
  protected readonly size = formatBytes;
  protected readonly newPath = signal('');

  protected addFile(): void {
    this.refused.emit(null);
    try {
      this.draft().add(this.newPath());
      this.newPath.set('');
    } catch (e) {
      this.refused.emit(e);
    }
  }

  protected rename(): void {
    const from = this.draft().selected();
    const to = this.newPath().trim();
    if (!from) return;
    if (!to) {
      this.refused.emit(
        new UploadError('Type the new path in the box under the file list, then Move.'),
      );
      return;
    }
    this.refused.emit(null);
    try {
      this.draft().rename(from, to);
      this.newPath.set('');
    } catch (e) {
      this.refused.emit(e);
    }
  }
}
