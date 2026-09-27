import { HttpClient } from '@angular/common/http';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { SettingView, Template } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { ToastService } from '../../ui/toast';
import { GitHubSettings } from './github-settings';
import { GlobalSecrets } from './global-secrets';
import { PreviewPasswords } from './preview-passwords';
import { PreviewPolicies } from './preview-policies';
import { SurfacesSettings } from './surfaces-settings';
import { UpdateSettings } from './update-settings';
import { EmailSettings } from './email-settings';
import { WatermarkSettings } from './watermark-settings';
import { DomainSettings } from './domain-settings';
import { LimitSettings } from './limit-settings';
import { ShareSettings } from './share-settings';
import { Skeleton } from '../../ui/skeleton';

export const SETTINGS_GROUPS = ['previews', 'domains', 'github', 'server'] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

/** The server's settings, one group or several; Admin shows each group as a tab. */
@Component({
  selector: 'app-settings',
  imports: [
    GitHubSettings,
    GlobalSecrets,
    PreviewPasswords,
    PreviewPolicies,
    Skeleton,
    SurfacesSettings,
    UpdateSettings,
    EmailSettings,
    WatermarkSettings,
    DomainSettings,
    LimitSettings,
    ShareSettings,
  ],
  host: { class: 'flex flex-col gap-7 [&>:last-child>.gw-section]:border-b-0' },
  template: `
    @if (!ready()) {
      <app-skeleton [count]="4" label="Loading settings" />
    } @else {
      @if (show('server') && canReadSettings()) {
        <app-update-settings [settings]="settings()" [(saving)]="saving" />
      }
      @if (show('server') && canReadSettings()) {
        <app-email-settings [settings]="settings()" [(saving)]="saving" />
      }
      @if (show('server') && canSurfaces()) {
        <app-surfaces-settings [(saving)]="saving" />
      }
      @if (show('github') && canManage()) {
        <app-github-settings />
      }
      @if (show('previews') && (canReadSettings() || canManagePolicies())) {
        <app-preview-policies
          [(templates)]="templates"
          [settings]="settings()"
          [(saving)]="saving"
        />
      }
      @if (show('previews') && canReadSettings()) {
        <app-preview-passwords [settings]="settings()" [(saving)]="saving" />
        <app-watermark-settings [settings]="settings()" [(saving)]="saving" />
      }
      @if (show('domains') && canReadSettings()) {
        <app-domain-settings [settings]="settings()" [(saving)]="saving" />
        <app-limit-settings [settings]="settings()" [(saving)]="saving" />
        <app-share-settings [settings]="settings()" [(saving)]="saving" />
      }
      @if (show('previews') && canSecrets()) {
        <app-global-secrets />
      }
    }
  `,
})
export class SettingsSections {
  readonly groups = input<readonly SettingsGroup[]>(SETTINGS_GROUPS);

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
  // The sections wait for the values, or they would show defaults and then flip to the real ones.
  protected readonly ready = signal(false);

  constructor() {
    effect(() => {
      const read = this.canReadSettings();
      const policies = this.show('previews') && (read || this.canManagePolicies());
      if (read || policies) untracked(() => void this.#load(read, policies));
      else this.ready.set(true);
    });
  }

  protected show(group: SettingsGroup): boolean {
    return this.groups().includes(group);
  }

  async #load(withSettings: boolean, withTemplates: boolean): Promise<void> {
    try {
      const [templates, settings] = await Promise.all([
        withTemplates
          ? firstValueFrom(this.#http.get<{ templates: Template[] }>('/v1/templates'))
          : null,
        withSettings
          ? firstValueFrom(this.#http.get<{ settings: SettingView[] }>('/v1/settings'))
          : null,
      ]);
      if (templates) this.templates.set(templates.templates);
      if (settings) this.settings.set(settings.settings);
    } catch (e) {
      this.#toasts.problem('Could not load settings', toProblem(e));
    } finally {
      this.ready.set(true);
    }
  }
}
