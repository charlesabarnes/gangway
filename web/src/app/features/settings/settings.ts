import { HttpClient } from '@angular/common/http';
import { Component, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { DISABLE_UI_PHRASE, TRIGGERS, type DefaultPasswordMode, type GitHubStatus, type Surfaces, type ManifestStart, type SecretListing, type SettingView, type Template, type Trigger } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { ToastService } from '../../ui/toast';
import { SecretsEditor } from '../secrets/secrets-editor';

const FIELD = 'block w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm focus:border-accent focus:outline-2 focus:outline-accent/30 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900';
const TRIGGER_LABEL: Record<Trigger, { name: string; help: string }> = {
  pr: { name: 'Pull requests', help: 'a project can pick another' },
  api: { name: 'API and CI', help: 'a token: a workflow, curl, an agent' },
  manual: { name: 'Deploy screen', help: 'a person, logged in' },
};

/**
 * Settings (§10.5, ADR-0013): the UI and MCP surfaces, the GitHub App connection, which
 * template each trigger deploys with, and the secrets every preview may receive. Each section is gated on its
 * own permission; the page is reachable with any of them.
 */
@Component({
  selector: 'app-settings',
  imports: [Btn, ConfirmDialog, RouterLink, SecretsEditor],
  template: `
    <section class="mx-auto max-w-4xl px-6 py-10">
      <h1 class="text-2xl font-semibold tracking-tight">Settings</h1>

      @if (canSurfaces()) {
        <h2 class="mt-8 text-base font-semibold">Surfaces</h2>
        <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">What answers besides the previews themselves. A surface that is off is a 404, as if it were never there.</p>
        <div class="mt-3 divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800" data-testid="surfaces">
          @if (surfaces(); as sf) {
            <div class="flex flex-wrap items-start justify-between gap-3 p-5" data-testid="surface-mcp">
              <div class="min-w-0 flex-1">
                <p class="flex items-center gap-2 font-medium"><span class="size-2 rounded-full" [class]="sf.mcp.enabled ? 'bg-emerald-500' : 'bg-neutral-400'" aria-hidden="true"></span>MCP {{ sf.mcp.enabled ? 'is on' : 'is off' }}</p>
                <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">Lets an agent deploy, check, read logs and destroy with four tools. It is one more public way in, so it starts off.</p>
                @if (sf.mcp.enabled) {
                  <p class="mt-3 text-sm">URL: <code class="font-mono" data-testid="mcp-url">{{ sf.mcp.url }}</code></p>
                  <p class="mt-2 text-xs text-neutral-500">Claude Code, with an API token that has the deploy scope:</p>
                  <pre class="mt-1 overflow-x-auto rounded-md bg-neutral-100 p-2 font-mono text-xs dark:bg-neutral-800" data-testid="mcp-snippet">claude mcp add --transport http gangway {{ sf.mcp.url }} --header "Authorization: Bearer gw_…"</pre>
                  <p class="mt-2 text-xs text-neutral-500" data-testid="mcp-oauth">Or with no token: add the URL as a custom connector in claude.ai (or <code class="font-mono">claude mcp add --transport http gangway {{ sf.mcp.url }}</code> and <code class="font-mono">/mcp</code> in Claude Code). You will be sent here to approve it, and can disconnect it under Account.</p>
                }
              </div>
              @if (sf.mcp.managedByConfig) { <span class="text-xs text-neutral-500" data-testid="mcp-managed">managed by config</span> }
              @else { <button appBtn [variant]="sf.mcp.enabled ? 'ghost' : 'primary'" type="button" [disabled]="saving() !== null" (click)="setMcp(!sf.mcp.enabled)" data-testid="mcp-toggle">{{ sf.mcp.enabled ? 'Turn off' : 'Turn on' }}</button> }
            </div>
            <div class="flex flex-wrap items-start justify-between gap-3 p-5" data-testid="surface-ui">
              <div class="min-w-0 flex-1">
                <p class="flex items-center gap-2 font-medium"><span class="size-2 rounded-full bg-emerald-500" aria-hidden="true"></span>The web UI is on</p>
                <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">This page. Turned off, it can only come back through the API with an admin-scoped token.</p>
                @if (!sf.ui.managedByConfig && !sf.adminTokenExists) {
                  <p class="mt-2 text-sm text-amber-700 dark:text-amber-400" data-testid="ui-needs-token">To turn it off, first <a routerLink="/account" class="underline underline-offset-2">create an API token with the admin scope</a>: it is the way back in.</p>
                }
              </div>
              @if (sf.ui.managedByConfig) { <span class="text-xs text-neutral-500" data-testid="ui-managed">managed by config</span> }
              @else { <button appBtn variant="ghost" type="button" [disabled]="saving() !== null || !sf.adminTokenExists" (click)="disableUiDialog().open()" data-testid="ui-toggle">Turn off</button> }
            </div>
            <app-confirm-dialog #uiDialog heading="Turn the web UI off?" confirmLabel="Turn the UI off" [phrase]="phrase" (confirmed)="disableUi()">
              <p>This page and every other will answer 404, and private previews will stop opening. Only this brings it back, with an admin-scoped API token:</p>
              <pre class="mt-2 overflow-x-auto rounded-md bg-neutral-100 p-2 font-mono text-xs text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100" data-testid="reenable-curl">{{ sf.reenableUi }}</pre>
            </app-confirm-dialog>
          } @else { <p class="p-5 text-sm text-neutral-500">Loading…</p> }
        </div>
      }

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

      @if (canReadSettings()) {
        <h2 class="mt-10 text-base font-semibold">Preview passwords</h2>
        <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">What a preview that follows the server default asks visitors for. A preview can still choose its own password, or none, when it is made or later on its page.</p>
        <form class="mt-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800" data-testid="preview-password" (submit)="$event.preventDefault(); savePassword()">
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="text-xs text-neutral-500">Default
              <select [class]="field" [disabled]="!canWriteSettings() || pwManaged() || saving() === 'password'" (change)="pwDraft.set($any($event.target).value)" data-testid="password-default">
                <option value="off" [selected]="pwDraft() === 'off'">off: previews are open</option>
                <option value="shared" [selected]="pwDraft() === 'shared'">one shared password</option>
                <option value="generated" [selected]="pwDraft() === 'generated'">generate one per new preview</option>
              </select>
            </label>
            @if (pwDraft() === 'shared') {
              <label class="text-xs text-neutral-500">{{ pwSet() ? 'New shared password (blank keeps the current one)' : 'Shared password' }}
                <input [class]="field" type="password" autocomplete="new-password" placeholder="any length" [disabled]="!canWriteSettings() || pwManaged()" [value]="pwValue()" (input)="pwValue.set($any($event.target).value)" data-testid="password-shared" />
              </label>
            }
          </div>
          @if (pwDraft() !== 'off') {
            <label class="mt-3 flex items-center gap-2 text-sm">
              <input type="checkbox" [checked]="pwLoginDraft()" [disabled]="!canWriteSettings() || pwManaged()" (change)="pwLoginDraft.set($any($event.target).checked)" data-testid="password-login" />
              People signed in to gangway skip the password
            </label>
          }
          <p class="mt-2 text-xs text-neutral-500" data-testid="password-help">
            @switch (pwDraft()) {
              @case ('shared') { Every preview that follows the default asks for this password. Changing it signs everyone out of those previews. }
              @case ('generated') { Each new preview gets its own password, printed once in its log. Previews that already exist are not changed. }
              @default { Previews that follow the default are open to anyone with the link. }
            }
            @if (pwManaged()) { <span class="block">managed by config</span> }
          </p>
          @if (canWriteSettings() && !pwManaged()) {
            <button appBtn type="submit" class="mt-3" [disabled]="saving() !== null || (pwDraft() === 'shared' && !pwSet() && pwValue() === '') || (pwDraft() === pwMode() && pwValue() === '' && pwLoginDraft() === pwLogin())" data-testid="password-save">{{ saving() === 'password' ? 'Saving…' : 'Save' }}</button>
          }
        </form>
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

  protected readonly phrase = DISABLE_UI_PHRASE;
  protected readonly canSurfaces = computed(() => this.auth.can('surfaces.manage'));
  protected readonly surfaces = signal<Surfaces | null>(null);
  protected readonly disableUiDialog = viewChild.required<ConfirmDialog>('uiDialog');
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
  protected readonly saving = signal<Trigger | 'surfaces' | 'password' | null>(null);
  /** ADR-0023: the saved default, what the form shows, whether a shared password exists. */
  protected readonly pwMode = signal<DefaultPasswordMode>('off');
  protected readonly pwDraft = signal<DefaultPasswordMode>('off');
  protected readonly pwSet = signal(false);
  protected readonly pwManaged = signal(false);
  protected readonly pwValue = signal('');
  protected readonly pwLogin = signal(true);
  protected readonly pwLoginDraft = signal(true);
  protected readonly error = signal<string | null>(null);

  constructor() {
    // Each section is gated on a permission that arrives with the session, possibly after
    // this page did; an effect asks once it is there (and again if it is granted later).
    effect(() => { if (this.canSurfaces()) untracked(() => void this.#loadSurfaces()); });
    effect(() => { if (this.canManage()) untracked(() => void this.#loadStatus()); });
    effect(() => { if (this.canReadSettings()) untracked(() => void this.#loadDefaults()); });
    effect(() => { if (this.canSecrets()) untracked(() => void this.#loadGlobal()); });
  }

  async #loadSurfaces(): Promise<void> {
    try { this.surfaces.set((await firstValueFrom(this.#http.get<{ surfaces: Surfaces }>('/v1/surfaces'))).surfaces); }
    catch (e) { this.#toasts.problem('Could not load the surfaces', toProblem(e)); }
  }

  async #putSurfaces(body: { ui?: boolean; mcp?: boolean; confirm?: string }, done: string): Promise<boolean> {
    if (this.saving()) return false;
    this.saving.set('surfaces');
    try {
      this.surfaces.set((await firstValueFrom(this.#http.put<{ surfaces: Surfaces }>('/v1/surfaces', body))).surfaces);
      this.#toasts.info(done);
      return true;
    } catch (e) {
      this.#toasts.problem('Could not change the surface', toProblem(e));
      return false;
    } finally {
      this.saving.set(null);
    }
  }

  protected setMcp(on: boolean): Promise<boolean> {
    return this.#putSurfaces({ mcp: on }, on ? 'MCP is on' : 'MCP is off; open agent sessions were dropped');
  }

  /** After this the UI is gone: the next request from this page is a 404. Say so and stay put. */
  protected disableUi(): Promise<boolean> {
    return this.#putSurfaces({ ui: false, confirm: DISABLE_UI_PHRASE }, 'The web UI is off. Use the curl you were shown to bring it back.');
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
      this.#readPassword(settings);
    } catch (e) { this.#toasts.problem('Could not load settings', toProblem(e)); }
  }

  #readPassword(settings: SettingView[]): void {
    const mode = settings.find((s) => s.key === 'previews.password.mode');
    const shared = settings.find((s) => s.key === 'previews.password.shared');
    this.pwMode.set((mode?.value as DefaultPasswordMode | undefined) ?? 'off');
    this.pwDraft.set(this.pwMode());
    this.pwSet.set(shared?.set ?? false);
    const login = settings.find((s) => s.key === 'previews.password.login');
    this.pwLogin.set(login?.value !== false);
    this.pwLoginDraft.set(this.pwLogin());
    this.pwManaged.set(!!(mode?.managedByConfig || shared?.managedByConfig || login?.managedByConfig));
  }

  protected async savePassword(): Promise<void> {
    if (this.saving() !== null) return;
    const mode = this.pwDraft();
    const value = this.pwValue();
    this.saving.set('password');
    try {
      const { settings } = await firstValueFrom(this.#http.put<{ settings: SettingView[] }>('/v1/settings/preview-password', { mode, login: this.pwLoginDraft(), ...(mode === 'shared' && value !== '' ? { value } : {}) }));
      this.#readPassword(settings);
      this.pwValue.set('');
      this.#toasts.info('Preview passwords saved', mode === 'off' ? 'Previews that follow the default are open.' : mode === 'shared' ? 'Previews that follow the default ask for the shared password.' : 'New previews get their own password, in their log.');
    } catch (e) {
      this.#toasts.problem('Could not save preview passwords', toProblem(e));
    } finally {
      this.saving.set(null);
    }
  }

  async #loadGlobal(): Promise<void> {
    try {
      this.globalSecrets.set((await firstValueFrom(this.#http.get<{ secrets: SecretListing[] }>('/v1/secrets'))).secrets);
      this.globalLoaded.set(true);
    } catch (e) { this.#toasts.problem('Could not load secrets', toProblem(e)); }
  }

  protected async setDefault(trigger: Trigger, id: string): Promise<void> {
    if (this.saving() !== null || id === this.defaults()[trigger]) return;
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
