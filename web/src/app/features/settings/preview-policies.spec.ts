import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import contract from '../../../testing/fixtures/contract.json';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { render, type Rendered } from '../../../testing/render';
import { PERMISSIONS, type Permission, type Template } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { Toasts } from '../../ui/toast';
import { PreviewPolicies } from './preview-policies';

let initial: Template[] = [];

@Component({
  imports: [PreviewPolicies, Toasts],
  template: `<app-preview-policies [(templates)]="templates" [settings]="[]" [(saving)]="saving" />
    <app-toasts />`,
})
class Host {
  readonly templates = signal(initial);
  readonly saving = signal<string | null>(null);
}

const template = (over: Partial<Template> = {}): Template => ({
  ...(contract.template as Template),
  ...over,
});
const STAGING = template({
  id: 'staging',
  name: 'Staging',
  builtin: false,
  visibility: 'private',
  ttl: null,
  idleAfter: 'never',
  clearance: 'high',
  hostId: 'docker-host',
});

async function open(o: { permissions?: Permission[]; templates?: Template[] } = {}) {
  initial = o.templates ?? [template(), STAGING];
  const r = await render(Host);
  const perms = o.permissions ?? [...PERMISSIONS];
  const loading = TestBed.inject(AuthService).refresh();
  r.http.expectOne('/v1/auth/session').flush({
    authenticated: true,
    setupRequired: false,
    user: { id: 'u1', email: 'ada@example.com', role: { id: 'admin', name: 'admin' } },
    permissions: perms,
  });
  await loading;
  await r.settle();
  return r;
}

const type = (r: Rendered<unknown>, id: string, v: string) => {
  const i = r.byTestId(id) as HTMLInputElement;
  i.value = v;
  i.dispatchEvent(new Event('input'));
};
const choose = async (r: Rendered<unknown>, id: string, v: string) => {
  const s = r.byTestId(id) as HTMLSelectElement;
  s.value = v;
  s.dispatchEvent(new Event('change'));
  await r.settle();
};
const inRow = (r: Rendered<unknown>, n: number, id: string) =>
  r.allByTestId('template')[n]!.querySelector(`[data-testid="${id}"]`) as HTMLElement;

describe('Settings: preview policies', () => {
  beforeAll(() => installDialogPolyfill());

  it('is read-only without templates.manage, one line per policy, built-in marked', async () => {
    const r = await open({ permissions: ['previews.read'] });
    expect(r.allByTestId('builtin')).toHaveLength(1);
    expect(r.allByTestId('summary').map((e) => e.textContent?.trim())).toEqual([
      'unlisted · lives 7d · sleeps after 30m',
      'private · never expires · never sleeps · host docker-host',
    ]);
    expect(r.byTestId('save')).toBeNull();
    expect(r.byTestId('create')).toBeNull();
  });

  it('edits a draft per row and PATCHes only what changed; the built-in has no delete', async () => {
    const r = await open();
    expect(inRow(r, 0, 'delete')).toBeNull();
    expect(inRow(r, 1, 'delete')).not.toBeNull();
    const save = () => inRow(r, 0, 'save') as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    type(r, 'ttl', '');
    const idle = inRow(r, 0, 'idle') as HTMLInputElement;
    idle.value = 'never';
    idle.dispatchEvent(new Event('input'));
    await choose(r, 'clearance', 'high');
    // An edit in the second row must not leak into the first row's patch.
    const other = inRow(r, 1, 'name') as HTMLInputElement;
    other.value = 'Other';
    other.dispatchEvent(new Event('input'));
    await r.settle();
    expect(save().disabled).toBe(false);
    r.byTestId('form-default')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await r.settle();
    const req = r.http.expectOne({ method: 'PATCH', url: '/v1/templates/default' });
    expect(req.request.body).toEqual({ ttl: null, idleAfter: 'never', clearance: 'high' });
    req.flush({ template: template({ ttl: null, idleAfter: 'never', clearance: 'high' }) });
    await r.settle();
    expect(save().disabled).toBe(true);
    expect(r.allByTestId('template')[0]!.textContent).toContain('never expires · never sleeps');
    expect(r.el.textContent).toContain('Saved Default');
  });

  it('shows a 422 for a bad duration on its row', async () => {
    const r = await open();
    type(r, 'ttl', 'soon');
    await r.settle();
    r.byTestId('form-default')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await r.settle();
    r.http.expectOne({ method: 'PATCH', url: '/v1/templates/default' }).flush(
      {
        type: 'about:blank',
        title: 'Unprocessable',
        status: 422,
        detail: 'ttl "soon" is not a duration like 12h or 7d',
      },
      { status: 422, statusText: 'Unprocessable' },
    );
    await r.until(() => r.byTestId('row-error') !== null, 'row error');
    expect(r.text('row-error')).toContain('not a duration');
  });

  it('creates a policy from a slug id and a name, adding it to the list', async () => {
    const r = await open();
    const btn = () => r.byTestId('new-save') as HTMLButtonElement;
    expect(btn().disabled).toBe(true);
    type(r, 'new-id', 'Not A Slug');
    type(r, 'new-name', 'X');
    await r.settle();
    expect(btn().disabled).toBe(true);
    type(r, 'new-id', 'ci');
    type(r, 'new-name', 'CI');
    await r.settle();
    expect(btn().disabled).toBe(false);
    r.byTestId('create')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await r.settle();
    const req = r.http.expectOne({ method: 'POST', url: '/v1/templates' });
    expect(req.request.body).toEqual({ id: 'ci', name: 'CI' });
    req.flush(
      { template: template({ id: 'ci', name: 'CI', builtin: false }) },
      { status: 201, statusText: 'Created' },
    );
    await r.settle();
    expect(r.allByTestId('template')).toHaveLength(3);
    expect((r.byTestId('new-id') as HTMLInputElement).value).toBe('');
  });

  it('reports a taken id next to the form', async () => {
    const r = await open();
    type(r, 'new-id', 'staging');
    type(r, 'new-name', 'Again');
    await r.settle();
    r.byTestId('create')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await r.settle();
    r.http.expectOne({ method: 'POST', url: '/v1/templates' }).flush(
      {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'template "staging" already exists',
      },
      { status: 409, statusText: 'Conflict' },
    );
    await r.until(() => r.byTestId('create-error') !== null, 'error');
    expect(r.text('create-error')).toContain('already exists');
  });

  it('delete asks first, then removes the row, or keeps it with a toast if refused', async () => {
    const r = await open();
    (inRow(r, 1, 'delete') as HTMLButtonElement).click();
    await r.settle();
    const dialog = r.byTestId('confirm') as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain('Delete Staging?');
    dialog.close('confirm');
    await r.settle();
    r.http.expectOne({ method: 'DELETE', url: '/v1/templates/staging' }).flush(
      {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: '"staging" is the default template for api; point those elsewhere first',
      },
      { status: 409, statusText: 'Conflict' },
    );
    await r.until(() => (r.el.textContent ?? '').includes('Could not delete Staging'), 'toast');
    expect(r.allByTestId('template')).toHaveLength(2);

    (inRow(r, 1, 'delete') as HTMLButtonElement).click();
    await r.settle();
    dialog.close('confirm');
    await r.settle();
    r.http
      .expectOne({ method: 'DELETE', url: '/v1/templates/staging' })
      .flush(null, { status: 204, statusText: 'No Content' });
    await r.until(() => r.allByTestId('template').length === 1, 'row gone');
  });
});
