import { HttpClient } from '@angular/common/http';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { SettingView, Template } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { ToastService } from '../../ui/toast';
import { ArtifactSettings } from './artifact-settings';
import { GitHubSettings } from './github-settings';
import { GlobalSecrets } from './global-secrets';
import { PreviewPasswords } from './preview-passwords';
import { PreviewPolicies } from './preview-policies';
import { SurfacesSettings } from './surfaces-settings';
import { UpdateSettings } from './update-settings';

@Component({
  selector: 'app-settings',
  imports: [
    ArtifactSettings,
    GitHubSettings,
    GlobalSecrets,
    PreviewPasswords,
    PreviewPolicies,
    SurfacesSettings,
    UpdateSettings,
  ],
  template: `
    <section class="gw-page [&>:last-child>.gw-section]:border-b-0">
      <div class="gw-title-rule"><h1 class="gw-h1">Settings</h1></div>
      @if (canReadSettings()) {
        <app-update-settings [settings]="settings()" [(saving)]="saving" />
      }
      @if (canSurfaces()) {
        <app-surfaces-settings [(saving)]="saving" />
      }
      @if (canManage()) {
        <app-github-settings />
      }
      @if (canReadSettings() || canManagePolicies()) {
        <app-preview-policies
          [(templates)]="templates"
          [settings]="settings()"
          [(saving)]="saving"
        />
      }
      @if (canReadSettings()) {
        <app-preview-passwords [settings]="settings()" [(saving)]="saving" />
        <app-artifact-settings [settings]="settings()" [(saving)]="saving" />
      }
      @if (canSecrets()) {
        <app-global-secrets />
      }
    </section>
  `,
})
export class SettingsPage {
  readonly #auth = inject(AuthService);
  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);

  protected readonly canSurfaces = computed(() => this.#auth.can('surfaces.manage'));
  protected readonly canManage = computed(() => this.#auth.can('github.manage'));
  protected readonly canSecrets = computed(() => this.#auth.can('repos.secrets'));
  protected readonly canReadSettings = computed(() => this.#auth.can('settings.read'));
  protected readonly canManagePolicies = computed(() => this.#auth.can('templates.manage'));
  protected readonly templates = signal<Template[]>([]);
  protected readonly settings = signal<SettingView[]>([]);
  protected readonly saving = signal<string | null>(null);

  constructor() {
    effect(() => {
      const read = this.canReadSettings();
      if (read || this.canManagePolicies()) untracked(() => void this.#load(read));
    });
  }

  async #load(withSettings: boolean): Promise<void> {
    try {
      const [{ templates }, settings] = await Promise.all([
        firstValueFrom(this.#http.get<{ templates: Template[] }>('/v1/templates')),
        withSettings
          ? firstValueFrom(this.#http.get<{ settings: SettingView[] }>('/v1/settings'))
          : null,
      ]);
      this.templates.set(templates);
      if (settings) this.settings.set(settings.settings);
    } catch (e) {
      this.#toasts.problem('Could not load settings', toProblem(e));
    }
  }
}
