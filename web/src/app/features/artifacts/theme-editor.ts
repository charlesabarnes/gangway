import {
  Component,
  computed,
  DOCUMENT,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  type ArtifactTheme,
  type ThemeFonts,
  type ThemeStyle,
  type TokenMap,
} from '../../core/artifacts.types';
import { AuthService } from '../../core/auth.service';
import type { ProblemError } from '../../core/problem';
import { Btn } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { FIELD } from '../../ui/field';
import { ToastService } from '../../ui/toast';
import { ArtifactFrame } from './artifact-frame';
import { ArtifactsService } from './artifacts.service';
import { LookEditor } from './look-editor';
import { SAMPLE_CANVAS, SAMPLE_DECK, SAMPLE_DOC, sampleFiles } from './samples';
import { themeCss } from './theme-css';
import { randomTheme } from './theme-random';
import { TokenEditor } from './token-editor';

type Mode = 'light' | 'dark';

/** Make or change a theme, and see it on a document, a deck and a canvas as you go. */
@Component({
  selector: 'app-theme-editor',
  imports: [ArtifactFrame, Btn, ConfirmDialog, LookEditor, RouterLink, TokenEditor],
  template: `
    <section class="gw-page !max-w-[1400px]">
      <a class="gw-back" routerLink="/artifacts" [queryParams]="{ tab: 'themes' }">← Themes</a>
      <div class="gw-title-rule flex flex-wrap items-end gap-5">
        <div class="flex flex-col gap-2">
          <span class="gw-label">{{
            isNew() ? 'New theme' : readonly() ? "gangway's own theme" : 'Theme'
          }}</span>
          <h1 class="gw-h1">{{ name() || 'Untitled theme' }}</h1>
        </div>
        <div class="mb-1 ml-auto flex flex-wrap gap-2.5">
          @if (!readonly()) {
            <button
              appBtn
              variant="ghost"
              type="button"
              (click)="shuffle()"
              title="A new look: type, shape and colours chosen to go together"
              data-testid="random-theme"
            >
              Random look
            </button>
          }
          @if (!isNew() && canManage() && !isDefault()) {
            <button
              appBtn
              variant="ghost"
              type="button"
              (click)="makeDefault()"
              data-testid="make-default"
            >
              Make default
            </button>
          }
          @if (readonly() && canManage()) {
            <a appBtn routerLink="/artifacts/themes/new" data-testid="duplicate-theme"
              >Start a theme from it</a
            >
          } @else if (canManage()) {
            <button
              appBtn
              type="button"
              [disabled]="busy()"
              (click)="save()"
              data-testid="save-theme"
            >
              {{ isNew() ? 'Create theme' : 'Save' }}
            </button>
          }
        </div>
      </div>
      @if (problem(); as e) {
        <p class="text-sm text-danger" role="alert" data-testid="theme-problem">{{ e.detail }}</p>
      }

      <div class="grid gap-8 lg:grid-cols-[400px_minmax(0,1fr)]">
        <aside class="flex flex-col gap-6">
          <div class="grid gap-4">
            <label class="gw-label flex flex-col gap-1"
              >Name<input
                [class]="field"
                [disabled]="readonly()"
                [value]="name()"
                (input)="name.set($any($event.target).value)"
                data-testid="theme-name"
            /></label>
            @if (isNew()) {
              <label class="gw-label flex flex-col gap-1"
                >Id
                <input
                  [class]="field + ' font-mono'"
                  [value]="id()"
                  (input)="id.set($any($event.target).value)"
                  placeholder="acme"
                  data-testid="theme-id"
              /></label>
            }
            <label class="gw-label flex flex-col gap-1"
              >Description<input
                [class]="field"
                [disabled]="readonly()"
                [value]="description()"
                (input)="description.set($any($event.target).value)"
            /></label>
          </div>

          <app-look-editor
            [fonts]="fonts()"
            [style]="style()"
            [readonly]="readonly()"
            (fontsChange)="fonts.set($event)"
            (styleChange)="style.set($event)"
          />

          <div class="grid gap-2">
            <span class="gw-label">Logo</span>
            <div class="flex items-center gap-4">
              @if (logo(); as l) {
                <img [src]="logoUrl()" alt="" class="h-8 max-w-40 object-contain" />
                @if (!readonly()) {
                  <button type="button" class="gw-action" (click)="logo.set(null)">Remove</button>
                }
              } @else {
                <span class="text-sm text-muted">None: titles carry a flag square</span>
              }
            </div>
            @if (!readonly()) {
              <input
                type="file"
                accept=".svg,image/svg+xml"
                class="text-sm"
                (change)="upload($event)"
                data-testid="theme-logo"
              />
            }
          </div>

          <app-token-editor
            [tokens]="tokens()"
            [house]="houseTokens()"
            [readonly]="readonly()"
            [(mode)]="mode"
            (changed)="tokens.set($event)"
          />
          @if (!isNew() && !readonly() && canManage()) {
            <button
              appBtn
              variant="danger"
              type="button"
              class="self-start"
              (click)="confirm().open()"
              data-testid="delete-theme"
            >
              Delete theme
            </button>
          }
        </aside>

        <div class="flex min-w-0 flex-col gap-5">
          <div class="gw-neatline p-[5px]">
            <app-artifact-frame
              [files]="doc"
              [themeCss]="css()"
              [mode]="mode()"
              [width]="1100"
              [height]="780"
            />
          </div>
          <div class="grid gap-5 md:grid-cols-2">
            <div class="gw-neatline p-[5px]">
              <app-artifact-frame
                [files]="deck"
                [themeCss]="css()"
                [mode]="mode()"
                [width]="1280"
                [height]="800"
              />
            </div>
            <div class="gw-neatline p-[5px]">
              <app-artifact-frame
                [files]="deck"
                [themeCss]="css()"
                [mode]="mode()"
                [width]="1280"
                [height]="800"
                hash="#/2"
              />
            </div>
          </div>
          <div class="gw-neatline p-[5px]">
            <app-artifact-frame
              [files]="canvas"
              [themeCss]="css()"
              [mode]="mode()"
              [width]="1280"
              [height]="640"
            />
          </div>
        </div>
      </div>
      <app-confirm-dialog
        [heading]="'Delete ' + name() + '?'"
        confirmLabel="Delete"
        (confirmed)="remove()"
      >
        Artifacts that name it go back to the default theme.
      </app-confirm-dialog>
    </section>
  `,
})
export class ThemeEditor {
  readonly #svc = inject(ArtifactsService);
  readonly #auth = inject(AuthService);
  readonly #router = inject(Router);
  readonly #toasts = inject(ToastService);
  readonly #params = toSignal(inject(ActivatedRoute).paramMap, { requireSync: true });
  protected readonly confirm = viewChild.required(ConfirmDialog);
  protected readonly field = FIELD;
  protected readonly doc = sampleFiles(SAMPLE_DOC);
  protected readonly deck = sampleFiles(SAMPLE_DECK);
  protected readonly canvas = sampleFiles(SAMPLE_CANVAS);

  readonly #routeId = computed(() => this.#params().get('id') ?? 'new');
  protected readonly isNew = computed(() => this.#routeId() === 'new');
  protected readonly readonly = computed(() => this.#routeId() === 'chart' || !this.canManage());
  protected readonly canManage = computed(() => this.#auth.can('artifacts.manage'));
  protected readonly isDefault = computed(
    () => this.#svc.themes()?.defaultTheme === this.#routeId(),
  );

  protected readonly id = signal('');
  protected readonly name = signal('');
  protected readonly description = signal('');
  protected readonly tokens = signal<{ light: TokenMap; dark: TokenMap }>({ light: {}, dark: {} });
  protected readonly fonts = signal<ThemeFonts>({});
  protected readonly style = signal<ThemeStyle>({});
  protected readonly logo = signal<string | null>(null);
  protected readonly mode = signal<Mode>('light');
  protected readonly busy = signal(false);
  protected readonly problem = signal<ProblemError | null>(null);

  protected readonly css = computed(() =>
    themeCss({
      builtin: false,
      tokens: this.tokens(),
      fonts: this.fonts(),
      style: this.style(),
      logo: this.logo(),
    }),
  );
  protected readonly houseTokens = computed(() => this.#svc.themes()?.house ?? null);
  protected readonly logoUrl = computed(() =>
    this.logo() ? `data:image/svg+xml,${encodeURIComponent(this.logo()!)}` : '',
  );

  readonly #doc = inject(DOCUMENT);
  readonly #random = toSignal(inject(ActivatedRoute).queryParamMap, { requireSync: true });
  // The look the last shuffle landed on, so the next is a different one.
  #look: string | undefined;
  #randomName = '';

  constructor() {
    effect(() => {
      const id = this.#routeId();
      untracked(() => void this.#load(id));
    });
    // Every font the kit serves, once per page, so each choice can be shown in its own face.
    effect(() => {
      const css = this.#svc.themes()?.fontCss;
      if (!css || this.#doc.getElementById('gw-kit-fonts')) return;
      const style = this.#doc.createElement('style');
      style.id = 'gw-kit-fonts';
      style.textContent = css;
      this.#doc.head.append(style);
    });
  }

  /** A theme in a new look; a new theme's name follows it until someone types one. */
  protected shuffle(): void {
    const t = randomTheme(Math.random, this.#look);
    this.#look = t.look;
    this.tokens.set(t.tokens);
    this.fonts.set(t.fonts);
    this.style.set(t.style);
    if (this.isNew() && (!this.name() || this.name() === this.#randomName)) {
      this.name.set(t.name);
      this.id.set(t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    }
    this.#randomName = t.name;
  }

  async #load(id: string): Promise<void> {
    const list = this.#svc.themes() ?? (await this.#svc.loadThemes().catch(() => null));
    if (!list) return;
    if (id === 'new') {
      this.name.set('');
      this.tokens.set({ light: {}, dark: {} });
      this.fonts.set({});
      this.style.set({});
      this.logo.set(null);
      if (this.#random().has('random')) this.shuffle();
      return;
    }
    const t: ArtifactTheme | undefined = list.themes.find((x) => x.id === id);
    if (!t)
      return this.problem.set({
        status: 404,
        title: 'Not found',
        detail: `No theme called ${id}`,
        requestId: null,
        retryAfter: null,
        issues: [],
      });
    this.id.set(t.id);
    this.name.set(t.name);
    this.description.set(t.description);
    this.tokens.set(structuredClone(t.tokens));
    this.fonts.set({ ...t.fonts });
    this.style.set({ ...t.style });
    this.logo.set(t.logo);
  }

  protected async upload(e: Event): Promise<void> {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) this.logo.set(await file.text());
  }

  protected async save(): Promise<void> {
    this.busy.set(true);
    this.problem.set(null);
    try {
      const id = this.isNew() ? this.id().trim() : this.#routeId();
      const t = await this.#svc.saveTheme(
        id,
        {
          name: this.name().trim(),
          description: this.description().trim(),
          tokens: this.tokens(),
          fonts: this.fonts(),
          style: this.style(),
          logo: this.logo(),
        },
        this.isNew(),
      );
      this.#toasts.info(`Saved ${t.name}: artifacts using it change on their next load`);
      if (this.isNew()) await this.#router.navigate(['/artifacts/themes', t.id]);
    } catch (err) {
      this.problem.set(err as ProblemError);
    } finally {
      this.busy.set(false);
    }
  }

  protected async makeDefault(): Promise<void> {
    try {
      await this.#svc.setDefaultTheme(this.#routeId());
      this.#toasts.info(`${this.name()} is the default theme now`);
    } catch (err) {
      this.problem.set(err as ProblemError);
    }
  }

  protected async remove(): Promise<void> {
    try {
      await this.#svc.deleteTheme(this.#routeId());
      await this.#router.navigate(['/artifacts'], { queryParams: { tab: 'themes' } });
    } catch (err) {
      this.problem.set(err as ProblemError);
    }
  }
}
