import { HttpClient } from '@angular/common/http';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { SettingView, Template } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { ToastService } from '../../ui/toast';
import { DefaultTemplates } from './default-templates';
import { GitHubSettings } from './github-settings';
import { GlobalSecrets } from './global-secrets';
import { PreviewPasswords } from './preview-passwords';
import { SurfacesSettings } from './surfaces-settings';

@Component({
  selector: 'app-settings',
  imports: [DefaultTemplates, GitHubSettings, GlobalSecrets, PreviewPasswords, SurfacesSettings],
  template: `
    <section class="mx-auto max-w-4xl px-6 py-10">
      <h1 class="text-2xl font-semibold tracking-tight">Settings</h1>
      @if (canSurfaces()) {
        <app-surfaces-settings [(saving)]="saving" />
      }
      @if (canManage()) {
        <app-github-settings />
      }
      @if (canReadSettings()) {
        <app-default-templates
          [templates]="templates()"
          [settings]="settings()"
          [(saving)]="saving"
        />
        <app-preview-passwords [settings]="settings()" [(saving)]="saving" />
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
  protected readonly templates = signal<Template[]>([]);
  protected readonly settings = signal<SettingView[]>([]);
  protected readonly saving = signal<string | null>(null);

  constructor() {
    effect(() => {
      if (this.canReadSettings()) untracked(() => void this.#load());
    });
  }

  async #load(): Promise<void> {
    try {
      const [{ templates }, { settings }] = await Promise.all([
        firstValueFrom(this.#http.get<{ templates: Template[] }>('/v1/templates')),
        firstValueFrom(this.#http.get<{ settings: SettingView[] }>('/v1/settings')),
      ]);
      this.templates.set(templates);
      this.settings.set(settings);
    } catch (e) {
      this.#toasts.problem('Could not load settings', toProblem(e));
    }
  }
}
