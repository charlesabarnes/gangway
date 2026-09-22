import { HttpClient } from '@angular/common/http';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { FORK_POLICIES, type ForkPolicy, type GitHubStatus, type ManifestStart, type Repo, type RepoPatch, type Visibility } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ToastService } from '../../ui/toast';

const FIELD = 'block w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm focus:border-accent focus:outline-2 focus:outline-accent/30 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900';
const FORK_HELP: Record<ForkPolicy, string> = {
  ask: 'a collaborator comments /preview deploy',
  auto: 'built automatically, public, no secrets',
  never: 'never built',
};
const VISIBILITIES: { value: Visibility | ''; label: string }[] = [{ value: '', label: 'server default' }, { value: 'public', label: 'public' }, { value: 'unlisted', label: 'unlisted' }, { value: 'private', label: 'private' }];

/**
 * GitHub (§10.4, ADR-0011): connect the App through the manifest flow, install it, and tune
 * the repositories pull requests have arrived from. The repository list is readable with
 * `previews.read`; connecting and editing need `github.manage`.
 */
@Component({
  selector: 'app-github',
  imports: [Btn],
  template: `
    <section class="mx-auto max-w-4xl px-6 py-10">
      <h1 class="text-2xl font-semibold tracking-tight">GitHub</h1>
      <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">Pull requests get URLs. A GitHub App of your own sends them here; nothing is copied by hand.</p>

      @if (canManage()) {
        <div class="mt-6 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800" data-testid="status">
          @if (status(); as s) {
            @if (s.configured) {
              <p class="flex items-center gap-2 font-medium"><span class="size-2 rounded-full bg-emerald-500" aria-hidden="true"></span>Connected as <a [href]="s.appUrl" target="_blank" rel="noopener" class="underline decoration-neutral-400 underline-offset-2">{{ s.appSlug || 'app ' + s.appId }}</a></p>
              <p class="mt-3 text-sm text-neutral-600 dark:text-neutral-400">Install the App on the repositories you want previews for. Each repository shows up below after its first pull request.</p>
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

      <h2 class="mt-10 text-base font-semibold">Repositories</h2>
      <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">Previews are named <code class="font-mono">&lt;slug&gt;-pr-&lt;n&gt;</code>. A repository appears here after its first pull request.</p>
      <ul class="mt-4 divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800" data-testid="repos">
        @for (r of repos(); track r.id) {
          <li class="px-4 py-4" [class.opacity-60]="!r.enabled" data-testid="repo">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span class="font-medium">{{ r.fullName }}</span>
              @if (!r.enabled) { <span class="rounded-full border border-amber-400 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400" data-testid="disabled">disabled</span> }
              <span class="ml-auto font-mono text-xs text-neutral-500">{{ r.slug }}-pr-…</span>
            </div>
            @if (r.disabledReason; as why) { <p class="mt-1 text-sm text-amber-700 dark:text-amber-400" data-testid="why">{{ why }}</p> }
            @if (canManage()) {
              <form (submit)="save($event, r)" novalidate class="mt-3 grid gap-3 sm:grid-cols-6" [attr.data-testid]="'form-' + r.id">
                <label class="text-xs text-neutral-500 sm:col-span-2">Slug<input [class]="field" [value]="draft(r).slug" (input)="edit(r, 'slug', $any($event.target).value)" data-testid="slug" /></label>
                <label class="text-xs text-neutral-500">Forks<select [class]="field" [value]="draft(r).forks" (change)="edit(r, 'forks', $any($event.target).value)" data-testid="forks">
                  @for (f of forkPolicies; track f) { <option [value]="f">{{ f }}</option> }</select></label>
                <label class="text-xs text-neutral-500">Visibility<select [class]="field" [value]="draft(r).visibility ?? ''" (change)="edit(r, 'visibility', $any($event.target).value || null)" data-testid="visibility">
                  @for (v of visibilities; track v.value) { <option [value]="v.value">{{ v.label }}</option> }</select></label>
                <label class="text-xs text-neutral-500">TTL<input [class]="field" placeholder="default" [value]="draft(r).ttl ?? ''" (input)="edit(r, 'ttl', $any($event.target).value || null)" data-testid="ttl" /></label>
                <div class="flex flex-col justify-end gap-1 text-xs">
                  <label class="flex items-center gap-1.5"><input type="checkbox" [checked]="draft(r).drafts" (change)="edit(r, 'drafts', $any($event.target).checked)" data-testid="drafts" />drafts too</label>
                  <label class="flex items-center gap-1.5"><input type="checkbox" [checked]="draft(r).enabled" (change)="edit(r, 'enabled', $any($event.target).checked)" data-testid="enabled" />enabled</label>
                </div>
                <div class="flex items-center gap-3 sm:col-span-6">
                  <button appBtn variant="ghost" type="submit" [disabled]="!dirty(r) || saving() === r.id" data-testid="save">Save</button>
                  <span class="text-xs text-neutral-500">Forks: {{ forkHelp[draft(r).forks] }}.</span>
                  @if (rowError()?.id === r.id) { <span class="text-sm text-red-700 dark:text-red-400" role="alert" data-testid="row-error">{{ rowError()?.message }}</span> }
                </div>
              </form>
            }
          </li>
        } @empty { <li class="px-4 py-8 text-center text-sm text-neutral-500" data-testid="no-repos">No pull requests have arrived yet.</li> }
      </ul>
    </section>
  `,
})
export class GitHub {
  protected readonly auth = inject(AuthService);
  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);

  protected readonly field = FIELD;
  protected readonly forkPolicies = FORK_POLICIES;
  protected readonly forkHelp = FORK_HELP;
  protected readonly visibilities = VISIBILITIES;

  protected readonly canManage = computed(() => this.auth.can('github.manage'));
  protected readonly status = signal<GitHubStatus | null>(null);
  protected readonly repos = signal<Repo[]>([]);
  protected readonly drafts = signal<Record<string, RepoPatch>>({});
  protected readonly busy = signal(false);
  protected readonly saving = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly rowError = signal<{ id: string; message: string } | null>(null);

  constructor() {
    void this.#loadRepos();
    // The status card is gated on a permission that arrives with the session, possibly
    // after this page did; an effect asks once it is there (and again if it is granted later).
    effect(() => { if (this.canManage()) untracked(() => void this.#loadStatus()); });
  }

  async #loadRepos(): Promise<void> {
    try { this.repos.set((await firstValueFrom(this.#http.get<{ repos: Repo[] }>('/v1/repos'))).repos); }
    catch (e) { this.#toasts.problem('Could not load repositories', toProblem(e)); }
  }

  async #loadStatus(): Promise<void> {
    try { this.status.set(await firstValueFrom(this.#http.get<GitHubStatus>('/v1/github'))); }
    catch (e) { this.error.set(toProblem(e).detail); }
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

  protected draft(r: Repo): Repo & RepoPatch {
    return { ...r, ...this.drafts()[r.id] };
  }

  protected dirty(r: Repo): boolean {
    const d = this.drafts()[r.id];
    return d !== undefined && Object.entries(d).some(([k, v]) => r[k as keyof RepoPatch] !== v);
  }

  protected edit<K extends keyof RepoPatch>(r: Repo, key: K, value: RepoPatch[K]): void {
    this.drafts.update((all) => ({ ...all, [r.id]: { ...all[r.id], [key]: value } }));
  }

  protected async save(e: Event, r: Repo): Promise<void> {
    e.preventDefault();
    const patch = this.drafts()[r.id];
    if (!patch || !this.dirty(r) || this.saving()) return;
    this.saving.set(r.id);
    this.rowError.set(null);
    try {
      const { repo } = await firstValueFrom(this.#http.patch<{ repo: Repo }>(`/v1/repos/${r.id}`, patch));
      this.repos.update((rs) => rs.map((x) => (x.id === repo.id ? repo : x)));
      this.drafts.update((all) => { const { [r.id]: _gone, ...rest } = all; return rest; });
      this.#toasts.info(`Saved ${repo.fullName}`);
    } catch (err) {
      const p = toProblem(err);
      this.rowError.set({ id: r.id, message: p.issues.length ? p.issues.map((i) => `${i.path}: ${i.message}`).join('; ') : p.detail });
    } finally {
      this.saving.set(null);
    }
  }
}
