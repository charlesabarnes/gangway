import { HttpClient } from '@angular/common/http';
import { Component, effect, inject, input, model, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { Project } from '../../core/api.types';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ClipboardService } from '../../ui/clipboard';
import { FIELD } from '../../ui/field';
import { ToastService } from '../../ui/toast';

@Component({
  selector: 'app-project-workflow',
  host: { class: 'block' },
  imports: [Btn],
  template: `
    <div class="flex flex-col gap-4" data-testid="workflow">
      <ol class="list-decimal space-y-2 pl-5 text-[15px] marker:font-mono marker:text-muted">
        <li>
          Say which port the image listens on:
          <input
            [class]="field + ' !inline-block !w-24 font-mono !text-sm'"
            type="number"
            min="1"
            max="65535"
            [value]="port()"
            (change)="setPort($any($event.target).value)"
            aria-label="Port"
            data-testid="port"
          />
        </li>
        <li>
          Commit this file to <span class="font-mono">{{ project().fullName }}</span> as
          <code class="font-mono">.github/workflows/gangway-preview.yml</code>. The image is built
          from the repository's Dockerfile.
        </li>
        <li>
          Open a pull request. The run builds, pushes to
          <span class="font-mono">ghcr.io</span>, and gangway runs it; a comment on the PR has the
          URL.
        </li>
      </ol>
      <div class="relative">
        <button
          appBtn
          variant="ghost"
          size="sm"
          type="button"
          class="absolute top-2 right-2 !border-log-fg bg-log !text-log-fg hover:!bg-log-fg/10"
          (click)="copy()"
          data-testid="copy"
        >
          Copy
        </button>
        <pre
          class="max-h-[32rem] overflow-auto bg-log p-4 font-mono text-xs leading-relaxed text-log-fg"
          data-testid="yaml"
          >{{ yaml() }}</pre>
      </div>
    </div>
  `,
})
export class ProjectWorkflow {
  readonly project = input.required<Project>();
  readonly port = model.required<number>();

  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);
  readonly #clipboard = inject(ClipboardService);

  protected readonly field = FIELD;
  protected readonly yaml = signal('');

  constructor() {
    effect(() => {
      const id = this.project().id,
        port = this.port();
      untracked(() => void this.#load(id, port));
    });
  }

  async #load(id: string, port: number): Promise<void> {
    try {
      this.yaml.set(
        await firstValueFrom(
          this.#http.get(`/v1/projects/${id}/workflow?port=${port}`, { responseType: 'text' }),
        ),
      );
    } catch (e) {
      this.#toasts.problem('Could not load the workflow', toProblem(e));
    }
  }

  protected setPort(v: string): void {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) this.port.set(n);
  }

  protected copy(): Promise<void> {
    return this.#clipboard.copy(
      this.yaml(),
      ['Copied the workflow'],
      ['Select the text and copy it', 'The browser would not let the page write to the clipboard.'],
    );
  }
}
