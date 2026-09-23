import { Component, output } from '@angular/core';

const PICKER =
  'cursor-pointer rounded-md border border-neutral-300 px-3.5 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800';

@Component({
  selector: 'app-drop-prompt',
  host: { class: 'block' },
  template: `
    <p class="font-medium">Drop a folder, files or a .zip</p>
    <p class="mt-1 text-sm text-neutral-500">
      We pick the runtime for you.
      <span class="group relative ml-1 inline-block">
        <span
          class="cursor-help border-b border-dotted border-neutral-400 text-neutral-600 outline-none dark:text-neutral-400"
          tabindex="0"
          aria-describedby="gangway-yml-tip"
          data-testid="gangway-yml-hint"
          >Want more control?</span
        >
        <span
          id="gangway-yml-tip"
          role="tooltip"
          data-testid="gangway-yml-tip"
          class="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 w-72 -translate-x-1/2 rounded-md bg-neutral-900 px-3 py-2 text-left text-xs leading-relaxed text-neutral-100 opacity-0 shadow-lg transition group-focus-within:opacity-100 group-hover:opacity-100 dark:bg-neutral-100 dark:text-neutral-900"
        >
          Add a <code class="font-mono">gangway.yml</code> to set the start command, build step,
          runtime version or databases. A Dockerfile or compose file is used as is.
        </span>
      </span>
    </p>
    <div class="mt-4 flex justify-center gap-3">
      <label [class]="picker"
        >Choose files<input
          type="file"
          multiple
          class="sr-only"
          (change)="changed($event)"
          data-testid="pick-files"
      /></label>
      <label [class]="picker"
        >Choose a folder<input
          type="file"
          webkitdirectory
          class="sr-only"
          (change)="changed($event)"
          data-testid="pick-folder"
      /></label>
    </div>
  `,
})
export class DropPrompt {
  readonly picked = output<File[]>();

  protected readonly picker = PICKER;

  protected changed(e: Event): void {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length > 0) this.picked.emit(files);
  }
}
