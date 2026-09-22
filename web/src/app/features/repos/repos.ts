import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { CLEARANCES, FORK_POLICIES, type Clearance, type ForkPolicy, type Repo, type RepoPatch, type SecretListing, type Template, type Visibility } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ToastService } from '../../ui/toast';
import { SecretsEditor } from '../secrets/secrets-editor';

const FIELD = 'block w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm focus:border-accent focus:outline-2 focus:outline-accent/30 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900';
const FORK_HELP: Record<ForkPolicy, string> = {
  ask: 'a collaborator comments /preview deploy',
  auto: 'built automatically, public, no secrets',
  never: 'never built',
};
const CLEARANCE_HELP: Record<Clearance, string> = { none: 'no .env at all', low: 'low only', standard: 'low + standard', high: 'everything' };
const VISIBILITIES: { value: Visibility | ''; label: string }[] = [{ value: '', label: "the template's" }, { value: 'public', label: 'public' }, { value: 'unlisted', label: 'unlisted' }, { value: 'private', label: 'private' }];
const PR_CLEARANCES: { value: Clearance | ''; label: string }[] = [{ value: '', label: "the template's" }, ...CLEARANCES.map((c) => ({ value: c, label: c }))];

/**
 * Repositories (ADR-0011, ADR-0013): the ones pull requests have arrived from. Each names
 * the template its previews follow, may override a field or two on top, carries its own
 * secrets, and decides what forks and drafts get. Readable with `previews.read`; editing
 * is `repos.manage`, secrets `repos.secrets`.
 */
@Component({
  selector: 'app-repos',
  imports: [Btn, RouterLink, SecretsEditor],
  template: `
    <section class="mx-auto max-w-4xl px-6 py-10">
      <h1 class="text-2xl font-semibold tracking-tight">Repositories</h1>
      <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">Previews are named <code class="font-mono">&lt;slug&gt;-pr-&lt;n&gt;</code>. A repository appears here after its first pull request; connect and install the App under <a routerLink="/settings" class="underline decoration-neutral-400 underline-offset-2">Settings</a>.</p>
      <ul class="mt-6 divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800" data-testid="repos">
        @for (r of repos(); track r.id) {
          <li class="px-4 py-4" [class.opacity-60]="!r.enabled" data-testid="repo">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span class="font-medium">{{ r.fullName }}</span>
              @if (!r.enabled) { <span class="rounded-full border border-amber-400 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400" data-testid="disabled">disabled</span> }
              <span class="rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-400" data-testid="template-chip">{{ templateName(r.templateId) }}</span>
              <span class="ml-auto font-mono text-xs text-neutral-500">{{ r.slug }}-pr-…</span>
            </div>
            @if (r.disabledReason; as why) { <p class="mt-1 text-sm text-amber-700 dark:text-amber-400" data-testid="why">{{ why }}</p> }
            @if (canManage()) {
              <form (submit)="save($event, r)" novalidate class="mt-3 grid gap-3 sm:grid-cols-6" [attr.data-testid]="'form-' + r.id">
                <label class="text-xs text-neutral-500 sm:col-span-2">Slug<input [class]="field" [value]="draft(r).slug" (input)="edit(r, 'slug', $any($event.target).value)" data-testid="slug" /></label>
                <label class="text-xs text-neutral-500 sm:col-span-2">Template<select [class]="field" (change)="edit(r, 'templateId', $any($event.target).value || null)" data-testid="template">
                  <option value="" [selected]="draft(r).templateId === null">the pull-request default</option>
                  @for (t of templates(); track t.id) { <option [value]="t.id" [selected]="t.id === draft(r).templateId">{{ t.name }}</option> }</select></label>
                <label class="text-xs text-neutral-500">Forks<select [class]="field" (change)="edit(r, 'forks', $any($event.target).value)" data-testid="forks">
                  @for (f of forkPolicies; track f) { <option [value]="f" [selected]="f === draft(r).forks">{{ f }}</option> }</select></label>
                <label class="text-xs text-neutral-500">Secrets for forks<select [class]="field" (change)="edit(r, 'forkClearance', $any($event.target).value)" data-testid="fork-clearance">
                  @for (c of clearances; track c) { <option [value]="c" [selected]="c === draft(r).forkClearance">{{ c }}</option> }</select></label>
                <p class="text-xs text-neutral-500 sm:col-span-6">Overrides <span class="font-normal">— on top of the template; leave one at "the template's" to follow it</span></p>
                <label class="text-xs text-neutral-500">Visibility<select [class]="field" (change)="edit(r, 'visibility', $any($event.target).value || null)" data-testid="visibility">
                  @for (v of visibilities; track v.value) { <option [value]="v.value" [selected]="v.value === (draft(r).visibility ?? '')">{{ v.label }}</option> }</select></label>
                <label class="text-xs text-neutral-500">TTL<input [class]="field" placeholder="the template's" [value]="draft(r).ttl ?? ''" (input)="edit(r, 'ttl', $any($event.target).value || null)" data-testid="ttl" /></label>
                <label class="text-xs text-neutral-500">Secrets for PRs<select [class]="field" (change)="edit(r, 'prClearance', $any($event.target).value || null)" data-testid="pr-clearance">
                  @for (c of prClearances; track c.value) { <option [value]="c.value" [selected]="c.value === (draft(r).prClearance ?? '')">{{ c.label }}</option> }</select></label>
                <div class="flex flex-col justify-end gap-1 text-xs">
                  <label class="flex items-center gap-1.5"><input type="checkbox" [checked]="draft(r).drafts" (change)="edit(r, 'drafts', $any($event.target).checked)" data-testid="drafts" />drafts too</label>
                  <label class="flex items-center gap-1.5"><input type="checkbox" [checked]="draft(r).enabled" (change)="edit(r, 'enabled', $any($event.target).checked)" data-testid="enabled" />enabled</label>
                </div>
                <div class="flex items-center gap-3 sm:col-span-6">
                  <button appBtn variant="ghost" type="submit" [disabled]="!dirty(r) || saving() === r.id" data-testid="save">Save</button>
                  <span class="text-xs text-neutral-500">Forks: {{ forkHelp[draft(r).forks] }}, cleared for {{ clearanceHelp[draft(r).forkClearance] }}. PRs get {{ draft(r).prClearance ? clearanceHelp[draft(r).prClearance!] : "the template's clearance" }}; <code class="font-mono">/preview secrets high</code> raises one PR.</span>
                  @if (rowError()?.id === r.id) { <span class="text-sm text-red-700 dark:text-red-400" role="alert" data-testid="row-error">{{ rowError()?.message }}</span> }
                </div>
              </form>
            }
            @if (canSecrets()) {
              <div class="mt-3 rounded-md border border-dashed border-neutral-300 p-3 dark:border-neutral-700" [attr.data-testid]="'secrets-' + r.id">
                <p class="text-xs font-medium text-neutral-700 dark:text-neutral-300">This repository's secrets <span class="font-normal text-neutral-500">— on top of the global ones; a name here wins</span></p>
                <app-secrets-editor [url]="'/v1/repos/' + r.id + '/env'" [initial]="secrets()[r.id] ?? []" />
              </div>
            }
          </li>
        } @empty { <li class="px-4 py-8 text-center text-sm text-neutral-500" data-testid="no-repos">No pull requests have arrived yet.</li> }
      </ul>
    </section>
  `,
})
export class ReposPage {
  protected readonly auth = inject(AuthService);
  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);

  protected readonly field = FIELD;
  protected readonly forkPolicies = FORK_POLICIES;
  protected readonly forkHelp = FORK_HELP;
  protected readonly clearances = CLEARANCES;
  protected readonly prClearances = PR_CLEARANCES;
  protected readonly clearanceHelp = CLEARANCE_HELP;
  protected readonly visibilities = VISIBILITIES;

  protected readonly canManage = computed(() => this.auth.can('repos.manage'));
  protected readonly canSecrets = computed(() => this.auth.can('repos.secrets'));
  protected readonly repos = signal<Repo[]>([]);
  protected readonly templates = signal<Template[]>([]);
  protected readonly secrets = signal<Record<string, SecretListing[]>>({});
  protected readonly drafts = signal<Record<string, RepoPatch>>({});
  protected readonly saving = signal<string | null>(null);
  protected readonly rowError = signal<{ id: string; message: string } | null>(null);

  constructor() {
    void this.#load();
  }

  async #load(): Promise<void> {
    try {
      const [{ repos }, { templates }] = await Promise.all([
        firstValueFrom(this.#http.get<{ repos: Repo[] }>('/v1/repos')),
        firstValueFrom(this.#http.get<{ templates: Template[] }>('/v1/templates')),
      ]);
      this.templates.set(templates);
      this.repos.set(repos);
      if (this.canSecrets()) await Promise.all(repos.map((r) => this.#loadSecrets(r.id)));
    } catch (e) { this.#toasts.problem('Could not load repositories', toProblem(e)); }
  }

  async #loadSecrets(id: string): Promise<void> {
    const { secrets } = await firstValueFrom(this.#http.get<{ secrets: SecretListing[] }>(`/v1/repos/${id}/env`));
    this.secrets.update((all) => ({ ...all, [id]: secrets }));
  }

  /** The chip: which template the repository is on, or that it follows the PR default. */
  protected templateName(id: string | null): string {
    if (id === null) return 'PR default';
    return this.templates().find((t) => t.id === id)?.name ?? id;
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
