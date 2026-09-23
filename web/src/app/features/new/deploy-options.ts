import { Component, input, model } from '@angular/core';
import { VISIBILITIES, type Detected, type Project, type Template } from '../../core/api.types';
import { FIELD } from '../../ui/field';
import { deployQuery } from './upload';

export type Who = '' | 'open' | 'password' | 'signed-in' | 'either';
export type DeployOptions = {
  name: string;
  visibility: string;
  ttl: string;
  who: Who;
  passwordSource: 'generate' | 'set' | 'shared';
  passwordValue: string;
  project: string;
  template: string;
};
export const NO_OPTIONS: DeployOptions = {
  name: '',
  visibility: '',
  ttl: '',
  who: '',
  passwordSource: 'generate',
  passwordValue: '',
  project: '',
  template: '',
};

const PASSWORD_LOGIN: Record<Who, string> = {
  '': '',
  open: '',
  password: 'off',
  'signed-in': 'only',
  either: 'on',
};

const asksPassword = (who: Who) => who === 'password' || who === 'either';

export const choosesPassword = (o: DeployOptions) =>
  asksPassword(o.who) && o.passwordSource === 'set';

function passwordParam(o: DeployOptions): string {
  if (o.who === 'open' || o.who === 'signed-in') return 'none';
  return asksPassword(o.who) && o.passwordSource === 'generate' ? 'generate' : '';
}

export function optionsQuery(
  o: DeployOptions,
  runtime: Detected | 'auto',
  addons: string | undefined,
): string {
  return deployQuery({
    runtime,
    name: o.name.trim(),
    visibility: o.visibility,
    ttl: o.ttl.trim(),
    project: o.project,
    template: o.template,
    addons,
    password: passwordParam(o),
    passwordLogin: PASSWORD_LOGIN[o.who],
  });
}

@Component({
  selector: 'app-deploy-options',
  host: { class: 'block' },
  template: `
    <details
      class="mt-6 rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800"
      data-testid="options"
    >
      <summary class="cursor-pointer text-sm font-medium text-neutral-600 dark:text-neutral-400">
        Options
      </summary>
      <div class="mt-3 grid gap-3 sm:grid-cols-5">
        <label class="text-xs text-neutral-500 sm:col-span-2"
          >Name<input
            [class]="field"
            [placeholder]="namePlaceholder()"
            [value]="options().name"
            (input)="set('name', $any($event.target).value)"
            data-testid="name"
        /></label>
        <label class="text-xs text-neutral-500"
          >Visibility<select
            [class]="field"
            (change)="set('visibility', $any($event.target).value)"
            data-testid="visibility"
          >
            <option value="">the template's</option>
            @for (v of visibilities; track v) {
              <option [value]="v">{{ v }}</option>
            }
          </select></label
        >
        <label class="text-xs text-neutral-500"
          >TTL<input
            [class]="field"
            placeholder="the template's"
            [value]="options().ttl"
            (input)="set('ttl', $any($event.target).value)"
            data-testid="ttl"
        /></label>
        <span class="self-end pb-2 text-xs text-neutral-500">12h, 7d, or none</span>
        <label class="text-xs text-neutral-500 sm:col-span-2"
          >Project<select
            [class]="field"
            (change)="set('project', $any($event.target).value)"
            data-testid="project"
          >
            <option value="">none</option>
            @for (p of projects(); track p.id) {
              <option [value]="p.id">{{ p.name }}</option>
            }
          </select></label
        >
        <label class="text-xs text-neutral-500 sm:col-span-2"
          >Template<select
            [class]="field"
            (change)="set('template', $any($event.target).value)"
            data-testid="template"
          >
            <option value="">the default for manual deploys</option>
            @for (t of templates(); track t.id) {
              <option [value]="t.id">{{ t.name }}</option>
            }
          </select></label
        >
        <label class="text-xs text-neutral-500 sm:col-span-3"
          >Who can open it<select
            [class]="field"
            (change)="set('who', $any($event.target).value)"
            data-testid="who"
          >
            <option value="">the server default</option>
            <option value="open">anyone with the link</option>
            <option value="password">anyone with the password</option>
            <option value="signed-in">people signed in to gangway</option>
            <option value="either">people signed in to gangway, or anyone with the password</option>
          </select></label
        >
        @if (asksPassword(options().who)) {
          <label class="text-xs text-neutral-500 sm:col-span-2"
            >Password<select
              [class]="field"
              (change)="set('passwordSource', $any($event.target).value)"
              data-testid="password-source"
            >
              <option value="generate">generate one (shown only in the log)</option>
              <option value="set">choose one…</option>
              <option value="shared">the server's shared password</option>
            </select></label
          >
          @if (options().passwordSource === 'set') {
            <label class="text-xs text-neutral-500 sm:col-span-3"
              >Preview password<input
                [class]="field"
                type="password"
                autocomplete="new-password"
                placeholder="any length"
                [value]="options().passwordValue"
                (input)="set('passwordValue', $any($event.target).value)"
                data-testid="password-value"
            /></label>
          }
        }
      </div>
    </details>
  `,
})
export class DeployOptionsForm {
  readonly options = model.required<DeployOptions>();
  readonly projects = input.required<Project[]>();
  readonly templates = input.required<Template[]>();
  readonly namePlaceholder = input.required<string>();

  protected readonly field = FIELD;
  protected readonly visibilities = VISIBILITIES;
  protected readonly asksPassword = asksPassword;

  protected set<K extends keyof DeployOptions>(key: K, value: DeployOptions[K]): void {
    this.options.update((o) => ({ ...o, [key]: value }));
  }
}
