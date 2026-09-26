import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, model } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { TRIGGERS, type SettingView, type Template, type Trigger } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { toProblem } from '../../core/problem';
import { FIELD } from '../../ui/field';
import { ToastService } from '../../ui/toast';

const TRIGGER_LABEL: Record<Trigger, { name: string; help: string }> = {
  pr: { name: 'Pull requests', help: 'a repository can pick another' },
  api: { name: 'API and CI', help: 'a token: a workflow, curl, an agent' },
  manual: { name: 'Deploy screen', help: 'a person, logged in' },
};

function defaultsFrom(settings: SettingView[]) {
  const defaults: Record<Trigger, string> = { pr: 'default', api: 'default', manual: 'default' };
  const managed: Record<Trigger, boolean> = { pr: false, api: false, manual: false };
  for (const t of TRIGGERS) {
    const row = settings.find((s) => s.key === `templates.default.${t}`);
    if (!row) continue;
    defaults[t] = String(row.value);
    managed[t] = row.managedByConfig;
  }
  return { defaults, managed };
}

@Component({
  selector: 'app-default-templates',
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-3">
      <div class="flex flex-col gap-1">
        <h3 class="gw-label">Used by default</h3>
        <p class="text-sm text-muted">
          The policy a deploy follows when neither the request nor its repository names one.
        </p>
      </div>
      <div class="grid gap-6 sm:grid-cols-3" data-testid="defaults">
        @for (t of triggers; track t) {
          <label class="flex flex-col gap-1"
            ><span class="gw-label">{{ triggerLabel[t].name }}</span>
            <select
              [class]="field"
              [disabled]="!canWrite() || managed()[t] || saving() === t"
              (change)="setDefault(t, $any($event.target).value)"
              [attr.data-testid]="'default-' + t"
            >
              @for (tpl of templates(); track tpl.id) {
                <option [value]="tpl.id" [selected]="tpl.id === defaults()[t]">
                  {{ tpl.name }}
                </option>
              }
            </select>
            <span class="text-xs text-muted">{{
              managed()[t] ? 'managed by config' : triggerLabel[t].help
            }}</span>
          </label>
        }
      </div>
    </div>
  `,
})
export class DefaultTemplates {
  readonly templates = input.required<Template[]>();
  readonly settings = input.required<SettingView[]>();
  readonly saving = model.required<string | null>();

  readonly #http = inject(HttpClient);
  readonly #toasts = inject(ToastService);
  readonly #auth = inject(AuthService);
  protected readonly canWrite = computed(() => this.#auth.can('settings.write'));

  protected readonly field = FIELD;
  protected readonly triggers = TRIGGERS;
  protected readonly triggerLabel = TRIGGER_LABEL;

  readonly #read = computed(() => defaultsFrom(this.settings()));
  protected readonly defaults = linkedSignal(() => this.#read().defaults);
  protected readonly managed = computed(() => this.#read().managed);

  protected async setDefault(trigger: Trigger, id: string): Promise<void> {
    if (this.saving() !== null || id === this.defaults()[trigger]) return;
    this.saving.set(trigger);
    try {
      await firstValueFrom(
        this.#http.put('/v1/settings', { values: { [`templates.default.${trigger}`]: id } }),
      );
      this.defaults.update((d) => ({ ...d, [trigger]: id }));
      this.#toasts.info(
        `${TRIGGER_LABEL[trigger].name} now deploy with ${this.templates().find((t) => t.id === id)?.name ?? id}`,
      );
    } catch (e) {
      this.#toasts.problem('Could not change the default', toProblem(e));
    } finally {
      this.saving.set(null);
    }
  }
}
