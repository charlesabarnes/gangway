import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { SecretListing } from '../../core/api.types';
import { toProblem } from '../../core/problem';
import { ToastService } from '../../ui/toast';
import { SecretsEditor } from '../secrets/secrets-editor';

@Component({
  selector: 'app-global-secrets',
  host: { class: 'block' },
  imports: [SecretsEditor],
  template: `
    <div class="gw-section">
      <div class="flex flex-col gap-1">
        <h2 class="gw-h2">Secrets for every preview</h2>
        <p class="gw-section-note">
          Written to <code class="font-mono">.env</code> in every checkout at deploy, at or below
          the preview's clearance — <span class="font-mono">low</span> &lt;
          <span class="font-mono">standard</span> &lt; <span class="font-mono">high</span>. The
          clearance comes from the template; a project's own secrets add to these and win on a name.
        </p>
      </div>
      <div data-testid="global-secrets">
        @if (loaded()) {
          <app-secrets-editor url="/v1/secrets" [initial]="secrets()" />
        } @else {
          <p class="text-sm text-muted">Loading…</p>
        }
      </div>
    </div>
  `,
})
export class GlobalSecrets {
  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);

  protected readonly secrets = signal<SecretListing[]>([]);
  protected readonly loaded = signal(false);

  constructor() {
    void this.#load();
  }

  async #load(): Promise<void> {
    try {
      this.secrets.set(
        (await firstValueFrom(this.#http.get<{ secrets: SecretListing[] }>('/v1/secrets'))).secrets,
      );
      this.loaded.set(true);
    } catch (e) {
      this.#toasts.problem('Could not load secrets', toProblem(e));
    }
  }
}
