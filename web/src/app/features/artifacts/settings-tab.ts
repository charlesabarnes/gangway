import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { SettingView } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { toProblem, type ProblemError } from '../../core/problem';
import { FIELD } from '../../ui/field';
import { ToastService } from '../../ui/toast';
import { ArtifactsService } from './artifacts.service';

const CSS = 'artifacts.customCss';

/** Server-wide choices for artifacts: the default theme, and whether an artifact may bring CSS. */
@Component({
  selector: 'app-artifact-settings-tab',
  imports: [RouterLink],
  template: `
    <div class="flex flex-col gap-7">
      <div class="gw-section">
        <div class="flex flex-col gap-1">
          <h2 class="gw-h2">Default theme</h2>
          <p class="gw-section-note">What an artifact is drawn in when it names no theme.</p>
        </div>
        <select
          [class]="field + ' max-w-80'"
          [disabled]="!canManage()"
          (change)="setDefault($any($event.target).value)"
          data-testid="default-theme"
        >
          @for (t of themes(); track t.id) {
            <option [value]="t.id" [selected]="t.isDefault">{{ t.name }}</option>
          }
        </select>
      </div>
      <div class="gw-section">
        <div class="flex flex-col gap-1">
          <h2 class="gw-h2">Stylesheets</h2>
          <p class="gw-section-note">
            An artifact may link a stylesheet of its own with css:, for the rare piece that should
            not look like the rest. Off keeps every artifact in its theme.
          </p>
        </div>
        <label class="flex items-center gap-3 self-start">
          <input
            type="checkbox"
            class="gw-box"
            [checked]="customCss()"
            [disabled]="!canWriteSettings() || busy()"
            (change)="setCss($any($event.target).checked)"
            data-testid="custom-css"
          />
          <span class="text-[15px]">Let artifacts bring their own stylesheet</span>
        </label>
      </div>
      <div class="gw-section border-b-0">
        <div class="flex flex-col gap-1">
          <h2 class="gw-h2">Watermark</h2>
          <p class="gw-section-note">gangway's mark on every preview page, artifacts included.</p>
        </div>
        <p class="text-[15px]">
          {{ watermark() ? 'Shown' : 'Hidden' }} on previews that do not choose.
          <a
            routerLink="/admin"
            [queryParams]="{ tab: 'previews' }"
            class="underline decoration-flag decoration-2 underline-offset-4"
            >Change it in Admin</a
          >
        </p>
      </div>
      @if (problem(); as e) {
        <p class="text-sm text-danger" role="alert">{{ e.detail }}</p>
      }
    </div>
  `,
})
export class ArtifactSettingsTab {
  readonly #svc = inject(ArtifactsService);
  readonly #auth = inject(AuthService);
  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);
  protected readonly field = FIELD;
  protected readonly canManage = computed(() => this.#auth.can('artifacts.manage'));
  protected readonly canWriteSettings = computed(() => this.#auth.can('settings.write'));
  protected readonly themes = computed(() => this.#svc.themes()?.themes ?? []);
  protected readonly customCss = signal(true);
  protected readonly watermark = signal(true);
  protected readonly busy = signal(false);
  protected readonly problem = signal<ProblemError | null>(null);

  constructor() {
    void this.#svc.loadThemes().catch(() => undefined);
    if (this.#auth.can('settings.read'))
      firstValueFrom(this.#http.get<{ settings: SettingView[] }>('/v1/settings')).then(
        ({ settings }) => {
          this.customCss.set(settings.find((s) => s.key === CSS)?.value !== false);
          this.watermark.set(settings.find((s) => s.key === 'previews.watermark')?.value !== false);
        },
        () => undefined,
      );
  }

  protected async setDefault(id: string): Promise<void> {
    try {
      await this.#svc.setDefaultTheme(id);
      this.#toasts.info('Artifacts that name no theme use it from their next load');
    } catch (e) {
      this.problem.set(e as ProblemError);
    }
  }

  protected async setCss(on: boolean): Promise<void> {
    this.busy.set(true);
    try {
      await firstValueFrom(this.#http.put('/v1/settings', { values: { [CSS]: on } }));
      this.customCss.set(on);
    } catch (e) {
      this.customCss.set(!on);
      this.problem.set(toProblem(e));
    } finally {
      this.busy.set(false);
    }
  }
}
