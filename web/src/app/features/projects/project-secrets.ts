import { HttpClient } from '@angular/common/http';
import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { Project, SecretListing } from '../../core/api.types';
import { toProblem } from '../../core/problem';
import { ToastService } from '../../ui/toast';
import { SecretsEditor } from '../secrets/secrets-editor';

@Component({
  selector: 'app-project-secrets',
  host: { class: 'block' },
  imports: [SecretsEditor],
  template: `
    @let p = project();
    <div class="flex flex-col gap-3" data-testid="secrets">
      <p class="m-0 max-w-3xl font-serif text-base leading-snug text-muted">
        Given to this repository's previews at or below their clearance, on top of the global ones
        in Settings; a name here wins.
        @if (p.prTrigger === 'workflow' && p.fullName) {
          With a workflow they reach the running container as its environment — build-time secrets
          stay in GitHub.
        }
      </p>
      @if (loaded()) {
        <app-secrets-editor [url]="'/v1/projects/' + p.id + '/env'" [initial]="secrets()" />
      } @else {
        <p class="text-sm text-muted">Loading…</p>
      }
    </div>
  `,
})
export class ProjectSecrets {
  readonly project = input.required<Project>();

  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);

  protected readonly secrets = signal<SecretListing[]>([]);
  protected readonly loaded = signal(false);

  constructor() {
    effect(() => {
      const id = this.project().id;
      untracked(() => void this.#load(id));
    });
  }

  async #load(id: string): Promise<void> {
    try {
      this.secrets.set(
        (
          await firstValueFrom(
            this.#http.get<{ secrets: SecretListing[] }>(`/v1/projects/${id}/env`),
          )
        ).secrets,
      );
      this.loaded.set(true);
    } catch (e) {
      this.#toasts.problem('Could not load secrets', toProblem(e));
    }
  }
}
