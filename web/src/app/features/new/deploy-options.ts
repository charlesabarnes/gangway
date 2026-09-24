import { Component, input, model } from '@angular/core';
import { VISIBILITIES, type Detected, type Project, type Template } from '../../core/api.types';
import { FIELD } from '../../ui/field';
import { deployQuery } from './upload';

export type Who = '' | 'open' | 'password' | 'signed-in' | 'either';
export type DeployOptions = {
  title: string;
  name: string;
  visibility: string;
  ttl: string;
  who: Who;
  passwordSource: 'generate' | 'set' | 'shared';
  passwordValue: string;
  project: string;
  template: string;
  network: string;
};
export const NO_OPTIONS: DeployOptions = {
  title: '',
  name: '',
  visibility: '',
  ttl: '',
  who: '',
  passwordSource: 'generate',
  passwordValue: '',
  project: '',
  template: '',
  network: '',
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
    title: o.title.trim(),
    name: o.name.trim(),
    visibility: o.visibility,
    ttl: o.ttl.trim(),
    project: o.project,
    template: o.template,
    addons,
    password: passwordParam(o),
    passwordLogin: PASSWORD_LOGIN[o.who],
    network: o.network,
  });
}

@Component({
  selector: 'app-deploy-options',
  host: { class: 'block' },
  template: `
    <details class="group border-y border-rule py-3" data-testid="options">
      <summary
        class="flex cursor-pointer list-none items-center gap-2.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flag [&::-webkit-details-marker]:hidden"
      >
        <span class="text-[10px] transition group-open:rotate-90" aria-hidden="true">▸</span
        ><span class="text-xs font-semibold tracking-[.14em] uppercase">Options</span
        ><span class="text-[13px] text-muted"
          >name, address, visibility, TTL, network, project, template, who can open it</span
        >
      </summary>
      <div class="mt-4 mb-2 grid gap-x-6 gap-y-5 sm:grid-cols-5">
        <label class="gw-label flex flex-col gap-1 sm:col-span-3"
          >Name<input
            [class]="field"
            maxlength="100"
            placeholder="anything, e.g. Checkout redesign"
            [value]="options().title"
            (input)="set('title', $any($event.target).value)"
            data-testid="title"
        /></label>
        <label class="gw-label flex flex-col gap-1 sm:col-span-2"
          >Address<input
            [class]="field"
            [placeholder]="namePlaceholder()"
            [value]="options().name"
            (input)="set('name', $any($event.target).value)"
            data-testid="name"
        /></label>
        <label class="gw-label flex flex-col gap-1"
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
        <label class="gw-label flex flex-col gap-1"
          >TTL<input
            [class]="field"
            placeholder="the template's"
            [value]="options().ttl"
            (input)="set('ttl', $any($event.target).value)"
            data-testid="ttl"
        /></label>
        <span class="self-end pb-2 text-xs text-muted">12h, 7d, or none</span>
        <label class="gw-label flex flex-col gap-1"
          >Network<select
            [class]="field"
            (change)="set('network', $any($event.target).value)"
            data-testid="network"
            title="Shared: one network for all single-service previews. Isolated: its own. Automatic: shared unless it has add-ons or several services."
          >
            <option value="">automatic</option>
            <option value="shared">shared</option>
            <option value="isolated">isolated</option>
          </select></label
        >
        <label class="gw-label flex flex-col gap-1 sm:col-span-2"
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
        <label class="gw-label flex flex-col gap-1 sm:col-span-2"
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
        <label class="gw-label flex flex-col gap-1 sm:col-span-3"
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
          <label class="gw-label flex flex-col gap-1 sm:col-span-2"
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
            <label class="gw-label flex flex-col gap-1 sm:col-span-3"
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

  // The label is set in caps; the control inside it is not.
  protected readonly field = `${FIELD} font-normal tracking-normal normal-case`;
  protected readonly visibilities = VISIBILITIES;
  protected readonly asksPassword = asksPassword;

  protected set<K extends keyof DeployOptions>(key: K, value: DeployOptions[K]): void {
    this.options.update((o) => ({ ...o, [key]: value }));
  }
}
