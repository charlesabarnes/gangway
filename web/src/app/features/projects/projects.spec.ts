import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { FakeEventSource } from '../../../testing/fake-event-source';
import contract from '../../../testing/fixtures/contract.json';
import { render, type Rendered } from '../../../testing/render';
import { PERMISSIONS, type Permission, type Preview, type Project } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { EVENT_SOURCE_FACTORY, SSE_JITTER } from '../../core/sse.service';
import { Toasts } from '../../ui/toast';
import { ProjectsPage } from './projects';

@Component({ template: '' })
class Blank {}

@Component({ imports: [ProjectsPage, Toasts], template: '<app-projects /><app-toasts />' })
class Host {}

const project = (over: Partial<Project> = {}): Project => ({
  ...(contract.project as Project),
  ...over,
});
const preview = (over: Partial<Preview> = {}): Preview => ({
  ...(contract.preview as Preview),
  ...over,
});

async function open(
  o: {
    permissions?: Permission[];
    projects?: Project[];
    previews?: Preview[];
    installed?: { fullName: string; installationId: string; private: boolean }[];
  } = {},
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
  const loading = TestBed.inject(AuthService).refresh();
  r.http.expectOne('/v1/auth/session').flush({
    authenticated: true,
    setupRequired: false,
    user: { id: 'u1', email: 'ada@example.com', role: { id: 'admin', name: 'admin' } },
    permissions: perms,
  });
  await loading;
  await r.settle();
  r.http.expectOne('/v1/projects').flush({ projects: o.projects ?? [] });
  r.http
    .expectOne((req) => req.url.startsWith('/v1/previews'))
    .flush({ seq: 1, previews: o.previews ?? [] });
  if (perms.includes('repos.manage'))
    r.http.expectOne('/v1/github/repositories').flush({ repositories: o.installed ?? [] });
  else r.http.expectNone('/v1/github/repositories');
  await r.settle();
  return r;
}

const type = (r: Rendered<unknown>, id: string, v: string) => {
  const i = r.byTestId(id) as HTMLInputElement;
  i.value = v;
  i.dispatchEvent(new Event('input'));
};

describe('Repositories', () => {
  it('shows each repository with its live previews; repo-less projects listed apart', async () => {
    const r = await open({
      projects: [
        project(),
        project({
          id: 'P2',
          name: 'whoami',
          slug: 'whoami',
          forge: null,
          fullName: null,
        }),
      ],
      previews: [
        preview({
          id: 'A',
          project: 'gw-docker-host-web-app-pr-4-k7q2',
          projectId: contract.project.id,
          state: 'awake',
        }),
        preview({ id: 'B', project: 'gw-docker-host-scratch', projectId: null, state: 'asleep' }),
        preview({
          id: 'C',
          project: 'gw-docker-host-web-app-pr-1',
          projectId: contract.project.id,
          state: 'destroyed',
        }),
      ],
    });
    expect(r.allByTestId('source').map((e) => e.textContent?.trim())).toEqual([
      'acme/web-app · workflow',
    ]);
    expect(r.allByTestId('project')[0]!.textContent).toContain('web-app-pr-4-k7q2');
    expect(r.allByTestId('project')[0]!.textContent).not.toContain('pr-1');
    expect(r.allByTestId('project')[0]!.getAttribute('href')).toBe('/repositories/web-app');
    expect(r.text('unconnected')).toContain('whoami');
    expect(r.el.textContent).not.toContain('gw-docker-host-scratch');
    expect(r.byTestId('template-chip')).toBeNull();
  });

  it('connecting an installed repository names it and opens on its Workflow tab', async () => {
    const r = await open({
      installed: [{ fullName: 'acme/store-admin', installationId: '1', private: true }],
    });
    (r.byTestId('new') as HTMLButtonElement).click();
    await r.settle();
    expect(r.byTestId('create-trigger-workflow')).toBeNull();
    type(r, 'create-repo', 'acme/store-admin');
    await r.settle();
    expect((r.byTestId('create-name') as HTMLInputElement).value).toBe('store-admin');
    expect((r.byTestId('create-trigger-workflow') as HTMLInputElement).checked).toBe(true);
    r.byTestId('create')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await r.settle();
    const req = r.http.expectOne({ method: 'POST', url: '/v1/projects' });
    expect(req.request.body).toEqual({
      name: 'store-admin',
      repository: 'acme/store-admin',
      prTrigger: 'workflow',
    });
    req.flush(
      {
        project: project({
          name: 'store-admin',
          slug: 'store-admin',
          fullName: 'acme/store-admin',
        }),
      },
      { status: 201, statusText: 'Created' },
    );
    await r.until(
      () => TestBed.inject(Router).url === '/repositories/store-admin?tab=workflow',
      'navigation',
    );
  });

  it('needs a repository, names it from the repo if blank, and shows a refusal', async () => {
    const r = await open();
    (r.byTestId('new') as HTMLButtonElement).click();
    await r.settle();
    const save = () => r.byTestId('create-save') as HTMLButtonElement;
    type(r, 'create-name', 'whoami');
    await r.settle();
    expect(save().disabled).toBe(true);
    expect(r.byTestId('create-template')).toBeNull();
    type(r, 'create-name', '');
    type(r, 'create-repo', 'acme/whoami');
    await r.settle();
    type(r, 'create-name', '');
    await r.settle();
    expect(save().disabled).toBe(false);
    r.byTestId('create')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await r.settle();
    const req = r.http.expectOne({ method: 'POST', url: '/v1/projects' });
    expect(req.request.body).toEqual({
      name: 'whoami',
      repository: 'acme/whoami',
      prTrigger: 'workflow',
    });
    req.flush(
      { type: 'about:blank', title: 'Conflict', status: 409, detail: 'slug "whoami" is taken' },
      { status: 409, statusText: 'Conflict' },
    );
    await r.until(() => r.byTestId('create-error') !== null, 'error');
    expect(r.text('create-error')).toContain('taken');
  });

  it('without repos.manage there is no Connect button and no repository lookup', async () => {
    const r = await open({ permissions: ['previews.read'] });
    expect(r.byTestId('new')).toBeNull();
    expect(r.el.textContent).toContain('No repositories yet');
  });
});
