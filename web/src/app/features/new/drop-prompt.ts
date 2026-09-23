import { Component, output } from '@angular/core';

const PICKER =
  'cursor-pointer rounded-[2px] border border-ink px-[15px] py-[9px] text-[13px] font-semibold tracking-[.1em] uppercase hover:bg-ink/5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-flag';

@Component({
  selector: 'app-drop-prompt',
  host: { class: 'block' },
  template: `
    <p class="font-serif text-2xl italic">Drop a folder, files or a .zip</p>
    <p class="mt-1.5 text-[15px] text-muted">
      We pick the runtime for you.
      <span class="group relative ml-1 inline-block">
        <span
          class="cursor-help border-b border-dotted border-muted text-ink outline-none focus-visible:shadow-[0_2px_0_var(--gw-flag)]"
          tabindex="0"
          aria-describedby="gangway-yml-tip"
          data-testid="gangway-yml-hint"
          >Want more control?</span
        >
        <span
          id="gangway-yml-tip"
          role="tooltip"
          data-testid="gangway-yml-tip"
          class="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 w-72 -translate-x-1/2 bg-log px-3 py-2 text-left text-xs leading-relaxed text-log-fg opacity-0 shadow-lg transition group-focus-within:opacity-100 group-hover:opacity-100"
        >
          Add a <code class="font-mono">gangway.yml</code> to set the start command, build step,
          runtime version or databases. A Dockerfile or compose file is used as is.
        </span>
      </span>
    </p>
    <div class="mt-4 flex justify-center gap-2.5">
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
