import { HttpClient } from '@angular/common/http';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { TRIGGERS, type GitHubStatus, type ManifestStart, type SecretListing, type SettingView, type Template, type Trigger } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ToastService } from '../../ui/toast';
import { SecretsEditor } from '../secrets/secrets-editor';

const FIELD = 'block w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm focus:border-accent focus:outline-2 focus:outline-accent/30 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900';
const TRIGGER_LABEL: Record<Trigger, { name: string; help: string }> = {
  pr: { name: 'Pull requests', help: 'a project can pick another' },
  api: { name: 'API and CI', help: 'a token: a workflow, curl, an agent' },
  manual: { name: 'Deploy screen', help: 'a person, logged in' },
};

/**
 * Settings (§10.5, ADR-0013): the GitHub App connection, which template each trigger
 * deploys with, and the secrets every preview may receive. Each section is gated on its
 * own permission; the page is reachable with any of them.
 */
@Component({
  selector: 'app-settings',
  imports: [Btn, SecretsEditor],
  template: `
    <section class="mx-auto max-w-4xl px-6 py-10">
      <h1 class="text-2xl font-semibold tracking-tight">Settings</h1>

      @if (canManage()) {
        <h2 class="mt-8 text-base font-semibold">GitHub</h2>
        <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">Pull requests get URLs. A GitHub App of your own sends them here; nothing is copied by hand.</p>
        <div class="mt-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800" data-testid="status">
          @if (status(); as s) {
            @if (s.configured) {
              <p class="flex items-center gap-2 font-medium"><span class="size-2 rounded-full bg-emerald-500" aria-hidden="true"></span>Connected as <a [href]="s.appUrl" target="_blank" rel="noopener" class="underline decoration-neutral-400 underline-offset-2">{{ s.appSlug || 'app ' + s.appId }}</a></p>
              <p class="mt-3 text-sm text-neutral-600 dark:text-neutral-400">The App is optional: a project can take pull requests from a workflow in its repository instead. Install it where a project should use it, then pick that repository when you make the project.</p>
              <div class="mt-3 flex flex-wrap items-center gap-3">
                <a appBtn [href]="s.installUrl" target="_blank" rel="noopener" data-testid="install">Install on repositories</a>
                @if (s.managedByConfig) { <span class="text-xs text-neutral-500" data-testid="managed">Credentials are managed by config (GANGWAY_GITHUB_*).</span> }
              </div>
            } @else {
              <p class="flex items-center gap-2 font-medium"><span class="size-2 rounded-full bg-neutral-400" aria-hidden="true"></span>Not connected</p>
              <p class="mt-3 text-sm text-neutral-600 dark:text-neutral-400">Create the App from here. GitHub will ask you to name it and where it lives (your account or an organization), then send you back.</p>
              @if (s.managedByConfig) {
                <p class="mt-3 text-sm text-amber-700 dark:text-amber-400" data-testid="managed">Some credentials are pinned by config (GANGWAY_GITHUB_*) but not all of them: missing {{ s.missing.join(', ') }}. Finish the set in the environment.</p>
              } @else {
                <div class="mt-3 flex items-center gap-3">
                  <button appBtn type="button" [disabled]="busy()" (click)="connect()" data-testid="connect">Create the GitHub App</button>
                  @if (error(); as e) { <span class="text-sm text-red-700 dark:text-red-400" role="alert" data-testid="error">{{ e }}</span> }
                </div>
              }
            }
            <p class="mt-4 text-xs text-neutral-500">Webhook: <code class="font-mono">{{ s.webhookUrl }}</code></p>
          } @else { <p class="text-sm text-neutral-500">Loading…</p> }
        </div>
      }

      @if (canReadSettings()) {
        <h2 class="mt-10 text-base font-semibold">Default templates</h2>
        <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">What a deploy follows when neither the request nor its project names a template.</p>
        <div class="mt-3 grid gap-3 rounded-lg border border-neutral-200 p-4 sm:grid-cols-3 dark:border-neutral-800" data-testid="defaults">
          @for (t of triggers; track t) {
            <label class="text-xs text-neutral-500">{{ triggerLabel[t].name }}
              <select [class]="field" [disabled]="!canWriteSettings() || managed()[t] || saving() === t" (change)="setDefault(t, $any($event.target).value)" [attr.data-testid]="'default-' + t">
                @for (tpl of templates(); track tpl.id) { <option [value]="tpl.id" [selected]="tpl.id === defaults()[t]">{{ tpl.name }}</option> }
              </select>
              <span class="mt-1 block font-normal">{{ managed()[t] ? 'managed by config' : triggerLabel[t].help }}</span>
            </label>
          }
        </div>
      }

      @if (canSecrets()) {
        <h2 class="mt-10 text-base font-semibold">Secrets for every preview</h2>
        <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">Written to <code class="font-mono">.env</code> in every checkout at deploy, at or below the preview's clearance — <span class="font-mono">low</span> &lt; <span class="font-mono">standard</span> &lt; <span class="font-mono">high</span>. The clearance comes from the template; a project's own secrets add to these and win on a name.</p>
        <div class="mt-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800" data-testid="global-secrets">
          @if (globalLoaded()) { <app-secrets-editor url="/v1/secrets" [initial]="globalSecrets()" /> } @else { <p class="text-sm text-neutral-500">Loading…</p> }
        </div>
      }
    </section>
  `,
})
export class SettingsPage {
  protected readonly auth = inject(AuthService);
  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);

  protected readonly field = FIELD;
  protected readonly triggers = TRIGGERS;
  protected readonly triggerLabel = TRIGGER_LABEL;

  protected readonly canManage = computed(() => this.auth.can('github.manage'));
  protected readonly canSecrets = computed(() => this.auth.can('repos.secrets'));
  protected readonly canReadSettings = computed(() => this.auth.can('settings.read'));
  protected readonly canWriteSettings = computed(() => this.auth.can('settings.write'));
  protected readonly status = signal<GitHubStatus | null>(null);
  protected readonly templates = signal<Template[]>([]);
  protected readonly defaults = signal<Record<Trigger, string>>({ pr: 'default', api: 'default', manual: 'default' });
  protected readonly managed = signal<Record<Trigger, boolean>>({ pr: false, api: false, manual: false });
  protected readonly globalSecrets = signal<SecretListing[]>([]);
  protected readonly globalLoaded = signal(false);
  protected readonly busy = signal(false);
  protected readonly saving = signal<Trigger | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    // Each section is gated on a permission that arrives with the session, possibly after
    // this page did; an effect asks once it is there (and again if it is granted later).
    effect(() => { if (this.canManage()) untracked(() => void this.#loadStatus()); });
    effect(() => { if (this.canReadSettings()) untracked(() => void this.#loadDefaults()); });
    effect(() => { if (this.canSecrets()) untracked(() => void this.#loadGlobal()); });
  }

  async #loadStatus(): Promise<void> {
    try { this.status.set(await firstValueFrom(this.#http.get<GitHubStatus>('/v1/github'))); }
    catch (e) { this.error.set(toProblem(e).detail); }
  }

  async #loadDefaults(): Promise<void> {
    try {
      const [{ templates }, { settings }] = await Promise.all([
        firstValueFrom(this.#http.get<{ templates: Template[] }>('/v1/templates')),
        firstValueFrom(this.#http.get<{ settings: SettingView[] }>('/v1/settings')),
      ]);
      this.templates.set(templates);
      const defaults = { ...this.defaults() };
      const managed = { ...this.managed() };
      for (const t of TRIGGERS) {
        const row = settings.find((s) => s.key === `templates.default.${t}`);
        if (!row) continue;
        defaults[t] = String(row.value);
        managed[t] = row.managedByConfig;
      }
      this.defaults.set(defaults);
      this.managed.set(managed);
    } catch (e) { this.#toasts.problem('Could not load settings', toProblem(e)); }
  }

  async #loadGlobal(): Promise<void> {
    try {
      this.globalSecrets.set((await firstValueFrom(this.#http.get<{ secrets: SecretListing[] }>('/v1/secrets'))).secrets);
      this.globalLoaded.set(true);
    } catch (e) { this.#toasts.problem('Could not load secrets', toProblem(e)); }
  }

  protected async setDefault(trigger: Trigger, id: string): Promise<void> {
    if (this.saving() || id === this.defaults()[trigger]) return;
    this.saving.set(trigger);
    try {
      await firstValueFrom(this.#http.put('/v1/settings', { values: { [`templates.default.${trigger}`]: id } }));
      this.defaults.update((d) => ({ ...d, [trigger]: id }));
      this.#toasts.info(`${TRIGGER_LABEL[trigger].name} now deploy with ${this.templates().find((t) => t.id === id)?.name ?? id}`);
    } catch (e) {
      this.#toasts.problem('Could not change the default', toProblem(e));
    } finally {
      this.saving.set(null);
    }
  }

  /**
   * The manifest flow's first step: GitHub only accepts the manifest as a FORM post from the
   * browser, so a form is made and submitted. The page leaves for github.com and comes back
   * at /github/callback with a code.
   */
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

  /** Split out so a spec can replace it: a real submit navigates the test browser away. */
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
