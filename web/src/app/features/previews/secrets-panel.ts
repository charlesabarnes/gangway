import { HttpClient } from '@angular/common/http';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { Preview, SecretListing } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { SecretsEditor } from '../secrets/secrets-editor';

/** This preview's own secrets: merged over its repository's and the org's, kept across rebuilds. */
@Component({
  selector: 'app-preview-secrets-panel',
  imports: [SecretsEditor],
  host: { class: 'flex flex-col gap-2.5' },
  template: `
    @if (shown()) {
      <h2 class="gw-label">Secrets</h2>
      <div class="gw-neatline px-5 py-4 text-[15px]" data-testid="preview-secrets">
        <p class="mb-3 text-sm text-muted">
          For this preview alone, on top of its repository's and the org's. Values are never shown
          again. The running containers keep what they started with: a change takes effect on the
          next rebuild{{ preview().source.kind === 'pr' ? ' or push' : '' }}.
        </p>
        @if (listing(); as l) {
          <app-secrets-editor [url]="url()" [initial]="l" [leveled]="false" />
        } @else if (error(); as e) {
          <p class="text-sm text-danger" role="alert">{{ e }}</p>
        }
      </div>
    }
  `,
})
export class PreviewSecretsPanel {
  readonly preview = input.required<Preview>();
  readonly #http = inject(HttpClient);
  readonly #auth = inject(AuthService);

  protected readonly listing = signal<SecretListing[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly url = computed(() => `/v1/previews/${this.preview().id}/env`);
  protected readonly shown = computed(() => {
    const p = this.preview();
    const served = p.source.kind === 'tarball' && p.source.serve === 'gangway';
    return !served && (this.#auth.can('previews.secrets') || this.#auth.can('repos.secrets'));
  });

  constructor() {
    effect(() => {
      if (this.shown()) void this.#load(this.url());
    });
  }

  async #load(url: string): Promise<void> {
    try {
      const { secrets } = await firstValueFrom(this.#http.get<{ secrets: SecretListing[] }>(url));
      this.listing.set(secrets);
    } catch (e) {
      this.error.set(toProblem(e).detail);
    }
  }
}
