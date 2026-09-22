import { HttpClient } from '@angular/common/http';
import { Component, DestroyRef, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { firstValueFrom, map } from 'rxjs';
import { CLEARANCES, FORK_POLICIES, PR_TRIGGERS, type Clearance, type ForkPolicy, type Project, type ProjectPatch, type SecretListing, type Template, type Visibility } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { Clock } from '../../core/clock';
import { toProblem } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { RelativeTimePipe } from '../../ui/relative-time.pipe';
import { StateBadge } from '../../ui/state-badge';
import { ToastService } from '../../ui/toast';
import { PreviewsStore } from '../previews/previews.store';
import { SecretsEditor } from '../secrets/secrets-editor';
import { FIELD, TRIGGER_HELP } from './projects';

type Tab = 'previews' | 'settings' | 'secrets' | 'workflow';
const FORK_HELP: Record<ForkPolicy, string> = { ask: 'a collaborator comments /preview deploy', auto: 'built automatically, public, no secrets', never: 'never built' };
const VISIBILITIES: { value: Visibility | ''; label: string }[] = [{ value: '', label: "the template's" }, { value: 'public', label: 'public' }, { value: 'unlisted', label: 'unlisted' }, { value: 'private', label: 'private' }];
const PR_CLEARANCES: { value: Clearance | ''; label: string }[] = [{ value: '', label: "the template's" }, ...CLEARANCES.map((c) => ({ value: c, label: c }))];

/**
 * One project (ADR-0014): its previews, its settings, its secrets, and -- when its pull
 * requests come from a workflow -- the workflow file to put in its repository.
 */
@Component({
  selector: 'app-project',
  imports: [Btn, ConfirmDialog, RelativeTimePipe, RouterLink, SecretsEditor, StateBadge],
  template: `
    <section class="mx-auto max-w-5xl px-6 py-10">
      <p class="text-sm text-neutral-500"><a routerLink="/projects" class="hover:text-accent">Projects</a> <span class="px-1">/</span> {{ project()?.slug ?? ref() }}</p>
      @if (project(); as p) {
        <div class="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 class="text-2xl font-semibold tracking-tight">{{ p.name }}</h1>
          @if (!p.enabled) { <span class="rounded-full border border-amber-400 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">disabled</span> }
          <span class="text-sm text-neutral-600 dark:text-neutral-400" data-testid="source">{{ p.fullName ? p.fullName : 'no repository' }}@if (p.fullName) { · pull requests from {{ p.prTrigger === 'workflow' ? 'its workflow' : 'the GitHub App' }} }</span>
        </div>
        @if (p.disabledReason; as why) { <p class="mt-1 text-sm text-amber-700 dark:text-amber-400">{{ why }}</p> }

        <nav class="mt-6 flex gap-5 border-b border-neutral-200 text-sm dark:border-neutral-800" aria-label="Project">
          @for (t of tabs(); track t.id) {
            <a [routerLink]="[]" [queryParams]="{ tab: t.id === 'previews' ? null : t.id }" class="-mb-px border-b-2 px-0.5 pb-2.5 font-medium"
               [class]="tab() === t.id ? 'border-accent text-neutral-900 dark:text-neutral-100' : 'border-transparent text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200'" [attr.data-testid]="'tab-' + t.id">{{ t.label }}</a>
          }
        </nav>

        @switch (tab()) {
          @case ('previews') {
            <div class="mt-6" data-testid="previews">
              @for (pv of previews(); track pv.id) {
                <a [routerLink]="['/previews', pv.id]" class="flex items-center gap-4 border-b border-neutral-200 py-3 text-sm last:border-0 hover:text-accent dark:border-neutral-800" data-testid="preview">
                  <app-state-badge [state]="pv.state" />
                  <span class="font-mono">{{ pv.project.replace(prefix(pv.project), '') }}</span>
                  <span class="text-neutral-500">{{ pv.source.kind === 'pr' ? '#' + $any(pv.source).number : pv.source.kind }}</span>
                  <span class="ml-auto text-xs text-neutral-500">{{ pv.createdAt | relativeTime: clock.now() }}</span>
                </a>
              } @empty {
                <p class="py-10 text-center text-sm text-neutral-500" data-testid="no-previews">
                  @if (p.fullName && p.prTrigger === 'workflow') { No previews yet. Add <a [routerLink]="[]" [queryParams]="{ tab: 'workflow' }" class="text-accent hover:underline">the workflow</a> and open a pull request. }
                  @else if (p.fullName) { No previews yet. Open a pull request on {{ p.fullName }}. }
                  @else { No previews yet. Deploy an image or tarball with <code class="font-mono">"project": "{{ p.slug }}"</code>. }
                </p>
              }
            </div>
          }
          @case ('settings') {
            @if (canManage()) {
              <form (submit)="save($event)" novalidate class="mt-6 space-y-8" data-testid="settings">
                <section>
                  <h2 class="text-sm font-semibold">Project</h2>
                  <div class="mt-3 grid gap-3 sm:grid-cols-3">
                    <label class="text-xs text-neutral-500">Name<input [class]="field" [value]="d().name" (input)="edit('name', $any($event.target).value)" data-testid="name" /></label>
                    <label class="text-xs text-neutral-500">Preview names<input [class]="field + ' font-mono'" [value]="d().slug" (input)="edit('slug', $any($event.target).value)" data-testid="slug" /><span class="mt-1 block font-mono">{{ d().slug }}-pr-&lt;n&gt;</span></label>
                    <label class="flex items-center gap-2 self-center text-sm"><input type="checkbox" [checked]="d().enabled" (change)="edit('enabled', $any($event.target).checked)" data-testid="enabled" />Previews on</label>
                  </div>
                </section>
                <section>
                  <h2 class="text-sm font-semibold">Source</h2>
                  <div class="mt-3 grid gap-3 sm:grid-cols-3">
                    <label class="text-xs text-neutral-500">Repository<input [class]="field" [value]="d().repository ?? ''" placeholder="owner/name — blank for none" (input)="edit('repository', $any($event.target).value.trim() || null)" data-testid="repository" /></label>
                    @if (d().repository) {
                      <label class="text-xs text-neutral-500 sm:col-span-2">Pull requests arrive through<select [class]="field" (change)="edit('prTrigger', $any($event.target).value)" data-testid="trigger">
                        @for (t of prTriggers; track t) { <option [value]="t" [selected]="t === d().prTrigger">{{ triggerHelp[t].name }}</option> }</select>
                        <span class="mt-1 block">{{ triggerHelp[d().prTrigger].help }}</span></label>
                    }
                  </div>
                  @if (d().repository && d().prTrigger === 'webhook') {
                    <div class="mt-3 grid gap-3 sm:grid-cols-3">
                      <label class="text-xs text-neutral-500">From forks<select [class]="field" (change)="edit('forks', $any($event.target).value)" data-testid="forks">
                        @for (f of forkPolicies; track f) { <option [value]="f" [selected]="f === d().forks">{{ f }}</option> }</select><span class="mt-1 block">{{ forkHelp[d().forks] }}</span></label>
                      <label class="text-xs text-neutral-500">Secrets for forks<select [class]="field" (change)="edit('forkClearance', $any($event.target).value)" data-testid="fork-clearance">
                        @for (c of clearances; track c) { <option [value]="c" [selected]="c === d().forkClearance">{{ c }}</option> }</select></label>
                      <label class="flex items-center gap-2 self-center text-sm"><input type="checkbox" [checked]="d().drafts" (change)="edit('drafts', $any($event.target).checked)" data-testid="drafts" />Draft pull requests too</label>
                    </div>
                  } @else if (d().repository) {
                    <p class="mt-2 text-xs text-neutral-500">Pull requests from forks are skipped: GitHub gives their workflow runs no OIDC token.</p>
                  }
                </section>
                <section>
                  <h2 class="text-sm font-semibold">Previews <span class="font-normal text-neutral-500">— anything left at "the template's" follows the template</span></h2>
                  <div class="mt-3 grid gap-3 sm:grid-cols-4">
                    <label class="text-xs text-neutral-500">Template<select [class]="field" (change)="edit('templateId', $any($event.target).value || null)" data-testid="template">
                      <option value="" [selected]="d().templateId === null">the default for its trigger</option>
                      @for (t of templates(); track t.id) { <option [value]="t.id" [selected]="t.id === d().templateId">{{ t.name }}</option> }</select></label>
                    <label class="text-xs text-neutral-500">Visibility<select [class]="field" (change)="edit('visibility', $any($event.target).value || null)" data-testid="visibility">
                      @for (v of visibilities; track v.value) { <option [value]="v.value" [selected]="v.value === (d().visibility ?? '')">{{ v.label }}</option> }</select></label>
                    <label class="text-xs text-neutral-500">Expires after<input [class]="field" placeholder="the template's" [value]="d().ttl ?? ''" (input)="edit('ttl', $any($event.target).value || null)" data-testid="ttl" /></label>
                    <label class="text-xs text-neutral-500">Secrets<select [class]="field" (change)="edit('prClearance', $any($event.target).value || null)" data-testid="pr-clearance">
                      @for (c of prClearances; track c.value) { <option [value]="c.value" [selected]="c.value === (d().prClearance ?? '')">{{ c.label }}</option> }</select></label>
                  </div>
                </section>
                <div class="flex items-center gap-3 border-t border-neutral-200 pt-4 dark:border-neutral-800">
                  <button appBtn type="submit" [disabled]="!dirty() || saving()" data-testid="save">Save</button>
                  @if (dirty()) { <button appBtn variant="ghost" type="button" (click)="draft.set({})" data-testid="discard">Discard</button> }
                  @if (saveError(); as e) { <span class="text-sm text-red-700 dark:text-red-400" role="alert" data-testid="save-error">{{ e }}</span> }
                  <button appBtn variant="danger" type="button" class="ml-auto" (click)="askDelete()" data-testid="delete">Delete project</button>
                </div>
              </form>
            } @else {
              <p class="mt-6 text-sm text-neutral-500">Changing a project needs the repos.manage permission.</p>
            }
          }
          @case ('secrets') {
            <div class="mt-6" data-testid="secrets">
              <p class="text-sm text-neutral-600 dark:text-neutral-400">Given to this project's previews at or below their clearance, on top of the global ones in Settings; a name here wins. @if (p.prTrigger === 'workflow' && p.fullName) { With a workflow they reach the running container as its environment — build-time secrets stay in GitHub. }</p>
              @if (secretsLoaded()) { <app-secrets-editor [url]="'/v1/projects/' + p.id + '/env'" [initial]="secrets()" /> } @else { <p class="mt-3 text-sm text-neutral-500">Loading…</p> }
            </div>
          }
          @case ('workflow') {
            <div class="mt-6 space-y-4" data-testid="workflow">
              <ol class="list-decimal space-y-1.5 pl-5 text-sm text-neutral-700 dark:text-neutral-300">
                <li>Say which port the image listens on: <input [class]="field + ' inline-block w-24 font-mono'" type="number" min="1" max="65535" [value]="port()" (change)="setPort($any($event.target).value)" aria-label="Port" data-testid="port" /></li>
                <li>Commit this file to <span class="font-mono">{{ p.fullName }}</span> as <code class="font-mono">.github/workflows/gangway-preview.yml</code>. The image is built from the repository's Dockerfile.</li>
                <li>Open a pull request. The run builds, pushes to <span class="font-mono">ghcr.io</span>, and gangway runs it; a comment on the PR has the URL.</li>
              </ol>
              <div class="relative">
                <button appBtn variant="ghost" type="button" class="absolute top-2 right-2" (click)="copy()" data-testid="copy">Copy</button>
                <pre class="max-h-[32rem] overflow-auto rounded-lg bg-neutral-950 p-4 font-mono text-xs leading-relaxed text-neutral-200" data-testid="yaml">{{ yaml() }}</pre>
              </div>
            </div>
          }
        }

        <app-confirm-dialog [heading]="'Delete ' + p.name + '?'" confirmLabel="Delete" (confirmed)="remove()">
          Its settings and secrets are removed. Its running previews keep running, no longer in a project. Pull requests from its repository stop getting previews.
        </app-confirm-dialog>
      } @else if (missing()) {
        <p class="mt-6 text-sm text-neutral-500" data-testid="missing">No such project. <a routerLink="/projects" class="text-accent hover:underline">Back to projects</a>.</p>
      }
    </section>
  `,
})
export class ProjectPage {
  readonly ref = input.required<string>();

  protected readonly auth = inject(AuthService);
  protected readonly store = inject(PreviewsStore);
  protected readonly clock = inject(Clock);
  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);
  readonly #router = inject(Router);
  // `viewChild` cannot sit on an ES #private member (NG1053), hence TypeScript `private`.
  private readonly dialog = viewChild.required(ConfirmDialog);

  protected readonly field = FIELD;
  protected readonly triggerHelp = TRIGGER_HELP;
  protected readonly prTriggers = PR_TRIGGERS;
  protected readonly forkPolicies = FORK_POLICIES;
  protected readonly forkHelp = FORK_HELP;
  protected readonly clearances = CLEARANCES;
  protected readonly prClearances = PR_CLEARANCES;
  protected readonly visibilities = VISIBILITIES;

  protected readonly canManage = computed(() => this.auth.can('repos.manage'));
  protected readonly canSecrets = computed(() => this.auth.can('repos.secrets'));
  protected readonly project = signal<Project | null>(null);
  protected readonly missing = signal(false);
  protected readonly templates = signal<Template[]>([]);
  protected readonly secrets = signal<SecretListing[]>([]);
  protected readonly secretsLoaded = signal(false);
  protected readonly draft = signal<ProjectPatch>({});
  protected readonly saving = signal(false);
  protected readonly saveError = signal<string | null>(null);
  protected readonly port = signal(3000);
  protected readonly yaml = signal('');

  readonly #query = toSignal(inject(ActivatedRoute).queryParamMap.pipe(map((q) => q.get('tab'))), { initialValue: null });
  protected readonly tabs = computed(() => {
    const p = this.project();
    return [
      { id: 'previews' as Tab, label: 'Previews' },
      ...(this.canManage() ? [{ id: 'settings' as Tab, label: 'Settings' }] : []),
      ...(this.canSecrets() ? [{ id: 'secrets' as Tab, label: 'Secrets' }] : []),
      ...(p?.fullName && p.prTrigger === 'workflow' ? [{ id: 'workflow' as Tab, label: 'Workflow' }] : []),
    ];
  });
  protected readonly tab = computed<Tab>(() => {
    const want = this.#query();
    return this.tabs().some((t) => t.id === want) ? (want as Tab) : 'previews';
  });
  protected readonly previews = computed(() => { const id = this.project()?.id; return this.store.previews().filter((p) => p.projectId === id); });

  /** The project as the form shows it: saved values, then the draft over them. */
  protected readonly d = computed(() => {
    const p = this.project()!;
    return { ...p, repository: p.fullName, ...this.draft() } as Project & { repository: string | null };
  });
  protected readonly dirty = computed(() => {
    const p = this.project();
    if (!p) return false;
    const saved: Record<string, unknown> = { ...p, repository: p.fullName };
    return Object.entries(this.draft()).some(([k, v]) => saved[k] !== v);
  });

  constructor() {
    this.store.connect();
    inject(DestroyRef).onDestroy(() => this.store.disconnect());
    effect(() => { const ref = this.ref(); untracked(() => void this.#load(ref)); });
    effect(() => { if (this.tab() === 'secrets' && this.project()) untracked(() => void this.#loadSecrets()); });
    effect(() => { if (this.tab() === 'workflow' && this.project()) { this.port(); untracked(() => void this.#loadYaml()); } });
  }

  async #load(ref: string): Promise<void> {
    try {
      const [{ project }, { templates }] = await Promise.all([
        firstValueFrom(this.#http.get<{ project: Project }>(`/v1/projects/${encodeURIComponent(ref)}`)),
        firstValueFrom(this.#http.get<{ templates: Template[] }>('/v1/templates')),
      ]);
      this.project.set(project);
      this.templates.set(templates);
      this.draft.set({});
    } catch (e) {
      const p = toProblem(e);
      if (p.status === 404) this.missing.set(true); else this.#toasts.problem('Could not load the project', p);
    }
  }

  async #loadSecrets(): Promise<void> {
    try {
      this.secrets.set((await firstValueFrom(this.#http.get<{ secrets: SecretListing[] }>(`/v1/projects/${this.project()!.id}/env`))).secrets);
      this.secretsLoaded.set(true);
    } catch (e) { this.#toasts.problem('Could not load secrets', toProblem(e)); }
  }

  async #loadYaml(): Promise<void> {
    try { this.yaml.set(await firstValueFrom(this.#http.get(`/v1/projects/${this.project()!.id}/workflow?port=${this.port()}`, { responseType: 'text' }))); }
    catch (e) { this.#toasts.problem('Could not load the workflow', toProblem(e)); }
  }

  protected prefix(project: string): string { return /^gw-[^-]+-/.exec(project)?.[0] ?? ''; }

  protected setPort(v: string): void {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) this.port.set(n);
  }

  protected async copy(): Promise<void> {
    try { await navigator.clipboard.writeText(this.yaml()); this.#toasts.info('Copied the workflow'); }
    catch { this.#toasts.info('Select the text and copy it', 'The browser would not let the page write to the clipboard.'); }
  }

  protected edit<K extends keyof ProjectPatch>(key: K, value: ProjectPatch[K]): void {
    this.draft.update((d) => ({ ...d, [key]: value }));
  }

  protected async save(e: Event): Promise<void> {
    e.preventDefault();
    const p = this.project();
    if (!p || !this.dirty() || this.saving()) return;
    const saved: Record<string, unknown> = { ...p, repository: p.fullName };
    const patch = Object.fromEntries(Object.entries(this.draft()).filter(([k, v]) => saved[k] !== v));
    this.saving.set(true);
    this.saveError.set(null);
    try {
      const { project } = await firstValueFrom(this.#http.patch<{ project: Project }>(`/v1/projects/${p.id}`, patch));
      this.project.set(project);
      this.draft.set({});
      this.#toasts.info(`Saved ${project.name}`);
      if (project.slug !== p.slug) await this.#router.navigate(['/projects', project.slug], { queryParams: { tab: 'settings' }, replaceUrl: true });
    } catch (err) {
      const pr = toProblem(err);
      this.saveError.set(pr.issues.length ? pr.issues.map((i) => `${i.path}: ${i.message}`).join('; ') : pr.detail);
    } finally {
      this.saving.set(false);
    }
  }

  protected askDelete(): void { this.dialog().open(); }

  protected async remove(): Promise<void> {
    const p = this.project();
    if (!p) return;
    try {
      await firstValueFrom(this.#http.delete(`/v1/projects/${p.id}`));
      this.#toasts.info(`Deleted ${p.name}`);
      await this.#router.navigateByUrl('/projects');
    } catch (err) { this.#toasts.problem(`Could not delete ${p.name}`, toProblem(err)); }
  }
}
