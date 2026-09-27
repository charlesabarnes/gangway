import { Component, computed, inject, input, output } from '@angular/core';
import type { ThemeFonts, ThemeStyle, ThemeStyleKey } from '../../core/artifacts.types';
import { FIELD } from '../../ui/field';
import { ArtifactsService } from './artifacts.service';
import { FontPicker } from './font-picker';
import { CHOICE_NAMES, STYLE_FIELDS } from './theme-tokens';

/** A theme's type, shape and layout: the fonts shown in their faces, the rest as choices. */
@Component({
  selector: 'app-look-editor',
  imports: [FontPicker],
  host: { class: 'flex flex-col gap-6' },
  template: `
    <div class="grid gap-3">
      <span class="gw-label">Type</span>
      @for (k of faceKeys; track k) {
        <app-font-picker
          [slot]="k"
          [label]="fontLabels[k]"
          [choices]="fontChoices()[k]"
          [labels]="faceLabels()"
          [value]="fonts()[k]"
          [readonly]="readonly()"
          (changed)="setFont(k, $event)"
        />
      }
      @for (k of titleKeys; track k) {
        <label class="flex items-center justify-between gap-3 text-sm"
          ><span class="text-muted">{{ fontLabels[k] }}</span>
          <select
            [class]="field + ' max-w-60'"
            [disabled]="readonly()"
            (change)="setFont(k, $any($event.target).value)"
            [attr.data-testid]="'font-' + k"
          >
            <option value="" [selected]="!fonts()[k]">Default</option>
            @for (f of fontChoices()[k]; track f) {
              <option [value]="f" [selected]="fonts()[k] === f">{{ fontName(f) }}</option>
            }
          </select></label
        >
      }
    </div>

    @for (g of styleGroups; track g) {
      <div class="grid gap-3">
        <span class="gw-label">{{ g }}</span>
        @for (s of styleFields(g); track s.key) {
          <label class="flex items-center justify-between gap-3 text-sm"
            ><span class="text-muted">{{ s.label }}</span>
            <select
              [class]="field + ' max-w-60'"
              [disabled]="readonly()"
              (change)="setStyle(s.key, $any($event.target).value)"
              [attr.data-testid]="'style-' + s.key"
            >
              @for (c of styleChoices()[s.key]; track c; let first = $first) {
                <option
                  [value]="first ? '' : c"
                  [selected]="first ? !style()[s.key] : style()[s.key] === c"
                >
                  {{ first ? 'Default (' + c + ')' : c }}
                </option>
              }
            </select></label
          >
        }
      </div>
    }
  `,
})
export class LookEditor {
  readonly #svc = inject(ArtifactsService);
  readonly fonts = input.required<ThemeFonts>();
  readonly style = input.required<ThemeStyle>();
  readonly readonly = input(false);
  readonly fontsChange = output<ThemeFonts>();
  readonly styleChange = output<ThemeStyle>();
  protected readonly field = FIELD;
  protected readonly faceKeys = ['serif', 'sans', 'mono', 'display'] as const;
  protected readonly titleKeys = ['titles', 'titleWeight', 'titleCase'] as const;
  protected readonly fontLabels: Record<keyof ThemeFonts, string> = {
    serif: 'Serif',
    sans: 'Sans',
    mono: 'Mono',
    display: 'Display',
    titles: 'Titles',
    titleWeight: 'Title weight',
    titleCase: 'Title case',
  };
  protected readonly styleGroups = ['Shape', 'Layout'] as const;

  protected readonly fontChoices = computed(() => {
    const t = this.#svc.themes();
    return {
      serif: t?.fonts.serif ?? [],
      sans: t?.fonts.sans ?? [],
      mono: t?.fonts.mono ?? [],
      display: t?.fonts.display ?? [],
      titles: t?.titles ?? [],
      titleWeight: t?.titleWeights ?? [],
      titleCase: t?.titleCases ?? [],
    };
  });
  protected readonly faceLabels = computed(() => this.#svc.themes()?.fontLabels ?? {});
  protected readonly styleChoices = computed(
    () => this.#svc.themes()?.style ?? ({} as Record<ThemeStyleKey, string[]>),
  );

  protected fontName(f: string): string {
    return this.#svc.themes()?.fontLabels[f] ?? CHOICE_NAMES[f] ?? f;
  }

  protected styleFields(group: 'Shape' | 'Layout') {
    return STYLE_FIELDS.filter((f) => f.group === group);
  }

  protected setStyle(k: ThemeStyleKey, v: string): void {
    const next: ThemeStyle = { ...this.style() };
    if (v) next[k] = v;
    else delete next[k];
    this.styleChange.emit(next);
  }

  protected setFont(k: keyof ThemeFonts, v: string): void {
    const next: ThemeFonts = { ...this.fonts() };
    if (v) (next as Record<string, string>)[k] = v;
    else delete next[k];
    this.fontsChange.emit(next);
  }
}
