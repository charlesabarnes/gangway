import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { GitHubStatus, ManifestStart } from '../../core/api.types';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';

@Component({
  selector: 'app-github-settings',
  host: { class: 'block' },
  imports: [Btn],
  template: `
    <div class="gw-section">
      <div class="flex flex-col gap-1">
        <h2 class="gw-h2">GitHub</h2>
        <p class="gw-section-note">
          Pull requests get URLs. A GitHub App of your own sends them here; nothing is copied by
          hand.
        </p>
      </div>
      <div class="flex flex-col gap-2.5" data-testid="status">
        @if (status(); as s) {
          @if (s.configured) {
            <p class="flex items-center gap-2 text-[17px] font-medium">
              <span class="size-[11px] shrink-0 bg-ok" aria-hidden="true"></span>Connected as
              <a
                [href]="s.appUrl"
                target="_blank"
                rel="noopener"
                class="underline underline-offset-2"
                >{{ s.appSlug || 'app ' + s.appId }}</a
              >
            </p>
            <p class="text-sm leading-normal text-muted">
              The App is optional: a project can take pull requests from a workflow in its
              repository instead. Install it where a project should use it, then pick that
              repository when you make the project.
            </p>
            <div class="flex flex-wrap items-center gap-4">
              <a appBtn [href]="s.installUrl" target="_blank" rel="noopener" data-testid="install"
                >Install on repositories</a
              >
              @if (s.managedByConfig) {
                <span class="text-xs text-muted" data-testid="managed"
                  >Credentials are managed by config (GANGWAY_GITHUB_*).</span
                >
              }
            </div>
          } @else {
            <p class="flex items-center gap-2 text-[17px] font-medium">
              <span class="size-[11px] shrink-0 bg-muted" aria-hidden="true"></span>Not connected
            </p>
            <p class="text-sm leading-normal text-muted">
              Create the App from here. GitHub will ask you to name it and where it lives (your
              account or an organization), then send you back.
            </p>
            @if (s.managedByConfig) {
              <p class="text-sm text-warn" data-testid="managed">
                Some credentials are pinned by config (GANGWAY_GITHUB_*) but not all of them:
                missing
                {{ s.missing.join(', ') }}. Finish the set in the environment.
              </p>
            } @else {
              <div class="flex items-center gap-3">
                <button
                  appBtn
                  type="button"
                  [disabled]="busy()"
                  (click)="connect()"
                  data-testid="connect"
                >
                  Create the GitHub App
                </button>
                @if (error(); as e) {
                  <span class="text-sm text-danger" role="alert" data-testid="error">{{ e }}</span>
                }
              </div>
            }
          }
          <p class="text-xs text-muted">
            Webhook: <code class="font-mono">{{ s.webhookUrl }}</code>
          </p>
        } @else {
          <p class="text-sm text-muted">Loading…</p>
        }
      </div>
    </div>
  `,
})
export class GitHubSettings {
  readonly #http = inject(HttpClient);

  protected readonly status = signal<GitHubStatus | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.#load();
  }

  async #load(): Promise<void> {
    try {
      this.status.set(await firstValueFrom(this.#http.get<GitHubStatus>('/v1/github')));
    } catch (e) {
      this.error.set(toProblem(e).detail);
    }
  }

  protected async connect(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const start = await firstValueFrom(this.#http.get<ManifestStart>('/v1/github/manifest'));
      this.submitManifest(start);
    } catch (e) {
      this.error.set(toProblem(e).detail);
      this.busy.set(false);
    }
  }

  protected submitManifest(start: ManifestStart): void {
    const form = document.createElement('form');
    form.method = 'post';
    form.action = start.action;
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'manifest';
    input.value = JSON.stringify(start.manifest);
    form.append(input);
    document.body.append(form);
    form.submit();
  }
}
