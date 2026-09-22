import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import contract from '../../../testing/fixtures/contract.json';
import { render, type Rendered } from '../../../testing/render';
import { PERMISSIONS, type GitHubStatus, type ManifestStart, type Permission, type Repo } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { Toasts } from '../../ui/toast';
import { GitHub } from './github';
import { GitHubCallback } from './github-callback';

@Component({ imports: [GitHub, Toasts], template: '<app-github /><app-toasts />' })
class Host {}

const status = (over: Partial<GitHubStatus> = {}): GitHubStatus => ({ ...(contract.githubStatus as GitHubStatus), ...over });
const repo = (over: Partial<Repo> = {}): Repo => ({ ...(contract.repo as Repo), ...over });
const NOT_CONNECTED = status({ configured: false, appId: '', appSlug: '', appUrl: null, installUrl: null, missing: ['github.appId', 'github.privateKey', 'github.webhookSecret'] });

async function open(o: { permissions?: Permission[]; status?: GitHubStatus; repos?: Repo[]; secretNames?: Record<string, string[]> } = {}) {
  const r = await render(Host);
  const perms = o.permissions ?? [...PERMISSIONS];
  const loading = TestBed.inject(AuthService).refresh();
  r.http.expectOne('/v1/auth/session').flush({ authenticated: true, setupRequired: false, user: { id: 'u1', email: 'ada@example.com', role: { id: 'admin', name: 'admin' } }, permissions: perms });
  await loading;
  await r.settle();
  r.http.expectOne('/v1/repos').flush({ repos: o.repos ?? [] });
  if (perms.includes('github.manage')) r.http.expectOne('/v1/github').flush(o.status ?? status());
  else r.http.expectNone('/v1/github');
  await r.settle();
  if (perms.includes('repos.secrets')) for (const repo of o.repos ?? []) r.http.expectOne(`/v1/repos/${repo.id}/env`).flush({ names: o.secretNames?.[repo.id] ?? [] });
  await r.settle();
  return r;
}

const type = (r: Rendered<unknown>, id: string, v: string) => { const i = r.byTestId(id) as HTMLInputElement; i.value = v; i.dispatchEvent(new Event('input')); };
const choose = async (r: Rendered<unknown>, id: string, v: string) => { const s = r.byTestId(id) as HTMLSelectElement; s.value = v; s.dispatchEvent(new Event('change')); await r.settle(); };

describe('GitHub', () => {
  it('connected: names the App, links to install, shows the webhook URL', async () => {
    const r = await open();
    expect(r.text('status')).toContain('Connected as gangway-preview');
    expect((r.byTestId('install') as HTMLAnchorElement).href).toBe('https://github.com/apps/gangway-preview/installations/new');
    expect(r.text('status')).toContain('https://hooks.preview.localhost:8443/github');
    expect(r.byTestId('connect')).toBeNull();
  });

  it('not connected: the manifest flow starts from a button and posts the manifest to GitHub as a form', async () => {
    const r = await open({ status: NOT_CONNECTED });
    expect(r.text('status')).toContain('Not connected');
    let posted: ManifestStart | null = null;
    const page = r.fixture.debugElement.query((d) => d.componentInstance instanceof GitHub).componentInstance as GitHub;
    (page as unknown as { submitManifest: (s: ManifestStart) => void }).submitManifest = (s) => { posted = s; };

    (r.byTestId('connect') as HTMLButtonElement).click(); await r.settle();
    const start: ManifestStart = { action: 'https://github.com/settings/apps/new?state=abc', manifest: { name: 'gangway preview.localhost' }, state: 'abc' };
    r.http.expectOne('/v1/github/manifest').flush(start);
    await r.settle();
    expect(posted).toEqual(start);
  });

  it('pinned by config but incomplete: says what is missing instead of offering the flow', async () => {
    const r = await open({ status: status({ configured: false, managedByConfig: true, missing: ['github.webhookSecret'] }) });
    expect(r.text('managed')).toContain('missing github.webhookSecret');
    expect(r.byTestId('connect')).toBeNull();
  });

  it('without github.manage: the repository list, read-only, and no status request', async () => {
    const r = await open({ permissions: ['previews.read'], repos: [repo()] });
    expect(r.byTestId('status')).toBeNull();
    expect(r.allByTestId('repo')).toHaveLength(1);
    expect(r.byTestId('slug')).toBeNull();
  });

  it('a repository is edited in a draft and saved as a PATCH of only what changed; a disabled one says why', async () => {
    const r = await open({ repos: [repo(), repo({ id: 'r2', fullName: 'other/web-app', slug: 'web-app-x1y2z3', enabled: false, disabledReason: 'slug "web-app" is taken by acme/web-app' })] });
    expect(r.allByTestId('repo')).toHaveLength(2);
    expect(r.allByTestId('why')[0]!.textContent).toContain('taken by acme/web-app');
    const save = () => r.allByTestId('save')[1] as HTMLButtonElement;
    expect(save().disabled).toBe(true);

    type(r, 'slug', 'ignored-first-row'); // the FIRST row's slug: must not leak into the second row's patch
    const second = r.allByTestId('repo')[1]!;
    const slug = second.querySelector('[data-testid="slug"]') as HTMLInputElement; slug.value = 'legacy'; slug.dispatchEvent(new Event('input'));
    const enabled = second.querySelector('[data-testid="enabled"]') as HTMLInputElement; enabled.checked = true; enabled.dispatchEvent(new Event('change'));
    const forks = second.querySelector('[data-testid="forks"]') as HTMLSelectElement; forks.value = 'auto'; forks.dispatchEvent(new Event('change'));
    await r.settle();
    expect(save().disabled).toBe(false);
    second.querySelector('[data-testid="form-r2"]')!.dispatchEvent(new Event('submit', { cancelable: true })); await r.settle();
    const req = r.http.expectOne({ method: 'PATCH', url: '/v1/repos/r2' });
    expect(req.request.body).toEqual({ slug: 'legacy', enabled: true, forks: 'auto' });
    req.flush({ repo: repo({ id: 'r2', fullName: 'other/web-app', slug: 'legacy', enabled: true, forks: 'auto' }) });
    await r.settle();
    expect(r.allByTestId('disabled')).toHaveLength(0);
    expect(r.allByTestId('repo')[1]!.textContent).toContain('legacy-pr-');
    expect(save().disabled).toBe(true);
  });

  it('a 409 on the slug is shown on that row', async () => {
    const r = await open({ repos: [repo()] });
    type(r, 'slug', 'taken'); await r.settle();
    r.byTestId('form-' + repo().id)!.dispatchEvent(new Event('submit', { cancelable: true })); await r.settle();
    r.http.expectOne({ method: 'PATCH', url: `/v1/repos/${repo().id}` }).flush({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'slug "taken" is taken by other/x' }, { status: 409, statusText: 'Conflict' });
    await r.until(() => r.byTestId('row-error') !== null, 'row error');
    expect(r.text('row-error')).toContain('taken by other/x');
  });

  it('visibility "server default" is sent as null', async () => {
    const r = await open({ repos: [repo({ visibility: 'public' })] });
    await choose(r, 'visibility', '');
    r.byTestId('form-' + repo().id)!.dispatchEvent(new Event('submit', { cancelable: true })); await r.settle();
    expect(r.http.expectOne({ method: 'PATCH', url: `/v1/repos/${repo().id}` }).request.body).toEqual({ visibility: null });
  });
});

describe('secrets', () => {
  it('lists names as chips (never a value), sets one with a PATCH, removes one with an unset', async () => {
    const r = await open({ repos: [repo()], secretNames: { [repo().id]: ['FONTAWESOME_TOKEN'] } });
    expect(r.allByTestId('secret').map((e) => e.textContent?.trim())).toEqual(['FONTAWESOME_TOKEN=••••×']);
    expect((r.byTestId('set-secret') as HTMLButtonElement).disabled).toBe(true);
    type(r, 'secret-name', 'API_KEY'); type(r, 'secret-value', 's3cret'); await r.settle();
    expect((r.byTestId('set-secret') as HTMLButtonElement).disabled).toBe(false);
    r.byTestId('secret-name')!.closest('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await r.settle();
    const req = r.http.expectOne({ method: 'PATCH', url: `/v1/repos/${repo().id}/env` });
    expect(req.request.body).toEqual({ set: { API_KEY: 's3cret' } });
    req.flush({ names: ['API_KEY', 'FONTAWESOME_TOKEN'] });
    await r.settle();
    expect(r.allByTestId('secret')).toHaveLength(2);
    expect(r.el.textContent).not.toContain('s3cret');
    expect((r.byTestId('secret-value') as HTMLInputElement).value).toBe('');

    (r.allByTestId('unset')[0] as HTMLButtonElement).click(); await r.settle();
    const un = r.http.expectOne({ method: 'PATCH', url: `/v1/repos/${repo().id}/env` });
    expect(un.request.body).toEqual({ unset: ['API_KEY'] });
    un.flush({ names: ['FONTAWESOME_TOKEN'] });
    await r.settle();
    expect(r.allByTestId('secret')).toHaveLength(1);
  });

  it('a bad name keeps the button disabled', async () => {
    const r = await open({ repos: [repo()] });
    type(r, 'secret-name', '1bad'); type(r, 'secret-value', 'x'); await r.settle();
    expect((r.byTestId('set-secret') as HTMLButtonElement).disabled).toBe(true);
  });

  it('without repos.secrets there is no section and no request', async () => {
    const ro = await open({ permissions: ['previews.read', 'github.manage'], repos: [repo()] });
    expect(ro.byTestId('secrets-' + repo().id)).toBeNull();
    ro.http.expectNone(`/v1/repos/${repo().id}/env`);
  });
});

describe('GitHubCallback', () => {
  const route = (query: Record<string, string>) => ({ provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(query) } } });

  it('exchanges code+state once and moves to /github', async () => {
    const r = await render(GitHubCallback, { providers: [route({ code: 'c0de', state: 'st4te' })], routes: [{ path: 'github', children: [] }] });
    expect(r.byTestId('working')).not.toBeNull();
    const req = r.http.expectOne({ method: 'POST', url: '/v1/github/manifest/exchange' });
    expect(req.request.body).toEqual({ code: 'c0de', state: 'st4te' });
    req.flush(status(), { status: 201, statusText: 'Created' });
    await r.until(() => TestBed.inject(Router).url === '/github', 'navigation');
  });

  it('a refused exchange stays put and says why', async () => {
    const r = await render(GitHubCallback, { providers: [route({ code: 'used', state: 'old' })] });
    r.http.expectOne({ method: 'POST', url: '/v1/github/manifest/exchange' }).flush({ type: 'about:blank', title: 'Unprocessable', status: 422, detail: 'the manifest state is unknown or expired; start again' }, { status: 422, statusText: 'Unprocessable' });
    await r.until(() => r.byTestId('error') !== null, 'error');
    expect(r.text('error')).toContain('start again');
  });

  it('no code in the URL is an error without a request', async () => {
    const r = await render(GitHubCallback, { providers: [route({})] });
    await r.until(() => r.byTestId('error') !== null, 'error');
    r.http.expectNone('/v1/github/manifest/exchange');
  });
});
