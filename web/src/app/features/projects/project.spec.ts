import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { FakeEventSource } from '../../../testing/fake-event-source';
import contract from '../../../testing/fixtures/contract.json';
import { render, type Rendered } from '../../../testing/render';
import {
  PERMISSIONS,
  type Permission,
  type Preview,
  type Project,
  type Template,
} from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { EVENT_SOURCE_FACTORY, SSE_JITTER } from '../../core/sse.service';
import { Toasts } from '../../ui/toast';
import { ProjectPage } from './project';

@Component({ template: '' })
class Blank {}

@Component({
  imports: [ProjectPage, Toasts],
  template: '<app-project ref="web-app" /><app-toasts />',
})
class Host {}

const P = contract.project as Project;
const project = (over: Partial<Project> = {}): Project => ({ ...P, ...over });
const template = (over: Partial<Template> = {}): Template => ({
  ...(contract.template as Template),
  ...over,
});

async function open(
  o: { permissions?: Permission[]; project?: Project; previews?: Preview[]; tab?: string } = {},
) {
  FakeEventSource.reset();
  const perms = o.permissions ?? [...PERMISSIONS];
  const r = await render(Host, {
    routes: [{ path: '**', component: Blank }],
    providers: [
      { provide: EVENT_SOURCE_FACTORY, useValue: (url: string) => new FakeEventSource(url) },
      { provide: SSE_JITTER, useValue: () => 0 },
    ],
  });
  if (o.tab) await TestBed.inject(Router).navigate([], { queryParams: { tab: o.tab } });
  const loading = TestBed.inject(AuthService).refresh();
  r.http.expectOne('/v1/auth/session').flush({
    authenticated: true,
    setupRequired: false,
    user: { id: 'u1', email: 'ada@example.com', role: { id: 'admin', name: 'admin' } },
    permissions: perms,
  });
  await loading;
  await r.settle();
  r.http.expectOne('/v1/projects/web-app').flush({ project: o.project ?? project() });
  r.http
    .expectOne('/v1/templates')
    .flush({ templates: [template(), template({ id: 'ci', name: 'CI', builtin: false })] });
  r.http
    .expectOne((req) => req.url.startsWith('/v1/previews'))
    .flush({ seq: 1, previews: o.previews ?? [] });
  await r.settle();
  return r;
}

const choose = async (r: Rendered<unknown>, id: string, v: string) => {
  const s = r.byTestId(id) as HTMLSelectElement;
  s.value = v;
  s.dispatchEvent(new Event('change'));
  await r.settle();
};

describe('Project', () => {
  beforeAll(installDialogPolyfill);

  it("the previews tab lists only this project's previews", async () => {
    const r = await open({
      previews: [
        {
          ...(contract.preview as Preview),
          id: 'A',
          project: 'gw-docker-host-web-app-pr-4-k7q2',
          projectId: P.id,
          source: { kind: 'pr', repo: 'acme/web-app', number: 4, sha: 'a' },
        },
        { ...(contract.preview as Preview), id: 'B', projectId: null },
      ],
    });
    expect(r.allByTestId('preview')).toHaveLength(1);
    expect(r.text('preview')).toContain('web-app-pr-4-k7q2');
    expect(r.text('preview')).toContain('#4');
    expect(r.allByTestId('tab-workflow')).toHaveLength(1);
  });

  it('an empty previews tab points at the workflow', async () => {
    const r = await open();
    expect(r.text('no-previews')).toContain('the workflow');
  });

  it("the workflow tab shows this project's file, refetched when the port changes", async () => {
    const r = await open({ tab: 'workflow' });
    const req = r.http.expectOne(`/v1/projects/${P.id}/workflow?port=3000`);
    expect(req.request.responseType).toBe('text');
    req.flush('name: gangway preview\n');
    await r.settle();
    expect(r.text('yaml')).toContain('name: gangway preview');
    const port = r.byTestId('port') as HTMLInputElement;
    port.value = '8080';
    port.dispatchEvent(new Event('change'));
    await r.settle();
    r.http.expectOne(`/v1/projects/${P.id}/workflow?port=8080`).flush('PORT: "8080"\n');
    await r.settle();
    expect(r.text('yaml')).toContain('8080');
  });

  it('a webhook project has no Workflow tab but sets its own forks and drafts', async () => {
    const r = await open({ project: project({ prTrigger: 'webhook' }), tab: 'settings' });
    expect(r.byTestId('tab-workflow')).toBeNull();
    expect(r.byTestId('forks')).not.toBeNull();
  });

  it('a project with no repository has no Workflow tab and no trigger', async () => {
    const r = await open({ project: project({ forge: null, fullName: null }), tab: 'settings' });
    expect(r.byTestId('tab-workflow')).toBeNull();
    expect(r.byTestId('trigger')).toBeNull();
  });

  it('a workflow project has no fork settings, since fork runs get no token', async () => {
    const r = await open({ tab: 'settings' });
    expect(r.byTestId('forks')).toBeNull();
  });

  it('settings PATCH only what changed, and a changed slug moves the URL', async () => {
    const r = await open({ tab: 'settings' });
    expect((r.byTestId('save') as HTMLButtonElement).disabled).toBe(true);
    await choose(r, 'template', 'ci');
    await choose(r, 'visibility', 'private');
    const slug = r.byTestId('slug') as HTMLInputElement;
    slug.value = 'store';
    slug.dispatchEvent(new Event('input'));
    await r.settle();
    // Back to the template's visibility, which equals the saved null, so it is not sent.
    await choose(r, 'visibility', '');
    r.byTestId('settings')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await r.settle();
    const req = r.http.expectOne({ method: 'PATCH', url: `/v1/projects/${P.id}` });
    expect(req.request.body).toEqual({ templateId: 'ci', slug: 'store' });
    req.flush({ project: project({ templateId: 'ci', slug: 'store' }) });
    await r.until(
      () => TestBed.inject(Router).url === '/repositories/store?tab=settings',
      'navigation',
    );
  });

  it('delete asks first, then leaves for the list', async () => {
    const r = await open({ tab: 'settings' });
    (r.byTestId('delete') as HTMLButtonElement).click();
    await r.settle();
    const dialog = r.byTestId('confirm') as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    dialog.close('confirm');
    await r.settle();
    r.http
      .expectOne({ method: 'DELETE', url: `/v1/projects/${P.id}` })
      .flush(null, { status: 204, statusText: 'No Content' });
    await r.until(() => TestBed.inject(Router).url === '/repositories', 'navigation');
  });

  it("secrets tab talks to the project's env", async () => {
    const r = await open({ tab: 'secrets' });
    r.http
      .expectOne(`/v1/projects/${P.id}/env`)
      .flush({ secrets: [{ name: 'API_KEY', level: 'standard' }] });
    await r.settle();
    expect(r.text('secrets')).toContain('API_KEY');
  });

  it('without repos.manage or repos.secrets only previews show', async () => {
    const r = await open({ permissions: ['previews.read'] });
    expect(r.byTestId('tab-settings')).toBeNull();
    expect(r.byTestId('tab-secrets')).toBeNull();
  });

  it('an unknown project says so', async () => {
    FakeEventSource.reset();
    const r = await render(Host, {
      routes: [{ path: '**', component: Blank }],
      providers: [
        { provide: EVENT_SOURCE_FACTORY, useValue: (url: string) => new FakeEventSource(url) },
        { provide: SSE_JITTER, useValue: () => 0 },
      ],
    });
    r.http.expectOne('/v1/projects/web-app').flush(
      {
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'no such project: web-app',
      },
      { status: 404, statusText: 'Not Found' },
    );
    r.http.expectOne('/v1/templates').flush({ templates: [] });
    await r.until(() => r.byTestId('missing') !== null, 'missing');
  });
});
