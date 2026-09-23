import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import contract from '../../../testing/fixtures/contract.json';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { render, type Rendered } from '../../../testing/render';
import { PERMISSIONS, type GitHubStatus, type ManifestStart, type Permission, type SettingView, type Surfaces, type Template } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { Toasts } from '../../ui/toast';
import { GitHubCallback } from './github-callback';
import { SettingsPage } from './settings';

installDialogPolyfill();

@Component({ imports: [SettingsPage, Toasts], template: '<app-settings /><app-toasts />' })
class Host {}

const status = (over: Partial<GitHubStatus> = {}): GitHubStatus => ({ ...(contract.githubStatus as GitHubStatus), ...over });
const template = (over: Partial<Template> = {}): Template => ({ ...(contract.template as Template), ...over });
const NOT_CONNECTED = status({ configured: false, appId: '', appSlug: '', appUrl: null, installUrl: null, missing: ['github.appId', 'github.privateKey', 'github.webhookSecret'] });
const setting = (key: string, value: unknown, managedByConfig = false): SettingView => ({ key, value, source: managedByConfig ? 'config' : 'database', managedByConfig, secret: false, set: true });

const surfaces = (over: Partial<Surfaces> = {}): Surfaces => ({ ...(contract.surfaces as Surfaces), ...over });

async function open(o: { permissions?: Permission[]; status?: GitHubStatus; templates?: Template[]; settings?: SettingView[]; globalNames?: string[]; surfaces?: Surfaces } = {}) {
  const r = await render(Host);
  const perms = o.permissions ?? [...PERMISSIONS];
  const loading = TestBed.inject(AuthService).refresh();
  r.http.expectOne('/v1/auth/session').flush({ authenticated: true, setupRequired: false, user: { id: 'u1', email: 'ada@example.com', role: { id: 'admin', name: 'admin' } }, permissions: perms });
  await loading;
  await r.settle();
  if (perms.includes('surfaces.manage')) r.http.expectOne('/v1/surfaces').flush({ surfaces: o.surfaces ?? surfaces() });
  else r.http.expectNone('/v1/surfaces');
  if (perms.includes('github.manage')) r.http.expectOne('/v1/github').flush(o.status ?? status());
  else r.http.expectNone('/v1/github');
  if (perms.includes('settings.read')) {
    r.http.expectOne('/v1/templates').flush({ templates: o.templates ?? [template()] });
    r.http.expectOne('/v1/settings').flush({ settings: o.settings ?? [setting('templates.default.pr', 'default'), setting('templates.default.api', 'default'), setting('templates.default.manual', 'default')] });
  } else { r.http.expectNone('/v1/templates'); r.http.expectNone('/v1/settings'); }
  if (perms.includes('repos.secrets')) r.http.expectOne('/v1/secrets').flush({ secrets: (o.globalNames ?? []).map((name) => ({ name, level: 'standard' })) });
  else r.http.expectNone('/v1/secrets');
  await r.settle();
  return r;
}

const choose = async (r: Rendered<unknown>, id: string, v: string) => { const s = r.byTestId(id) as HTMLSelectElement; s.value = v; s.dispatchEvent(new Event('change')); await r.settle(); };

describe('Settings: surfaces (§10.5)', () => {
  const put = async (r: Rendered<unknown>, testId: string) => { (r.byTestId(testId) as HTMLButtonElement).click(); await r.settle(); return r.http.expectOne({ method: 'PUT', url: '/v1/surfaces' }); };

  it('MCP off: one click turns it on with no ceremony, then the URL and the Claude Code line show', async () => {
    const r = await open();
    expect(r.text('surface-mcp')).toContain('MCP is off');
    expect(r.byTestId('mcp-url')).toBeNull();
    const req = await put(r, 'mcp-toggle');
    expect(req.request.body).toEqual({ mcp: true });
    req.flush({ surfaces: surfaces({ mcp: { ...surfaces().mcp, enabled: true } }) });
    await r.settle();
    expect(r.text('mcp-url')).toBe('https://mcp.preview.localhost:8443');
    expect(r.text('mcp-snippet')).toContain('claude mcp add --transport http gangway https://mcp.preview.localhost:8443');
  });

  it('with no admin token the UI cannot be turned off, and the page says how to fix that', async () => {
    const r = await open();
    expect((r.byTestId('ui-toggle') as HTMLButtonElement).disabled).toBe(true);
    expect(r.text('ui-needs-token')).toContain('admin scope');
  });

  it('turning the UI off shows the re-enable curl and needs the phrase typed exactly', async () => {
    const r = await open({ surfaces: surfaces({ adminTokenExists: true }) });
    (r.byTestId('ui-toggle') as HTMLButtonElement).click(); await r.settle();
    expect(r.text('reenable-curl')).toContain(`-d '{"ui":true}'`);
    const ok = r.byTestId('confirm-ok') as HTMLButtonElement;
    const phrase = r.byTestId('confirm-phrase') as HTMLInputElement;
    expect(ok.disabled).toBe(true);
    phrase.value = 'disable the ui'; phrase.dispatchEvent(new Event('input')); await r.settle();
    expect(ok.disabled).toBe(true);
    phrase.value = 'disable the UI'; phrase.dispatchEvent(new Event('input')); await r.settle();
    expect(ok.disabled).toBe(false);
    ok.click(); await r.settle();
    const req = r.http.expectOne({ method: 'PUT', url: '/v1/surfaces' });
    expect(req.request.body).toEqual({ ui: false, confirm: 'disable the UI' });
    req.flush({ surfaces: surfaces({ adminTokenExists: true, ui: { enabled: false, managedByConfig: false } }) });
    await r.settle();
    expect(r.el.textContent).toContain('The web UI is off');
  });

  it('a surface pinned in config has no button and says so', async () => {
    const r = await open({ surfaces: surfaces({ ui: { enabled: true, managedByConfig: true }, mcp: { ...surfaces().mcp, managedByConfig: true } }) });
    expect(r.byTestId('ui-toggle')).toBeNull();
    expect(r.byTestId('mcp-toggle')).toBeNull();
    expect(r.text('ui-managed')).toBe('managed by config');
    expect(r.text('mcp-managed')).toBe('managed by config');
  });

  it('without surfaces.manage there is no card and no request', async () => {
    const r = await open({ permissions: ['settings.read'] });
    expect(r.byTestId('surfaces')).toBeNull();
  });
});

describe('Settings: GitHub', () => {
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
    const page = r.fixture.debugElement.query((d) => d.componentInstance instanceof SettingsPage).componentInstance as SettingsPage;
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

  it('without github.manage there is no status card and no request', async () => {
    const r = await open({ permissions: ['settings.read'] });
    expect(r.byTestId('status')).toBeNull();
    expect(r.byTestId('defaults')).not.toBeNull();
  });
});

describe('Settings: default templates (ADR-0013)', () => {
  const two = [template(), template({ id: 'staging', name: 'Staging', builtin: false })];

  it('one select per trigger, showing what settings say; a change is one PUT of that key', async () => {
    const r = await open({ templates: two, settings: [setting('templates.default.pr', 'default'), setting('templates.default.api', 'staging'), setting('templates.default.manual', 'default')] });
    expect((r.byTestId('default-pr') as HTMLSelectElement).value).toBe('default');
    expect((r.byTestId('default-api') as HTMLSelectElement).value).toBe('staging');
    await choose(r, 'default-pr', 'staging');
    const req = r.http.expectOne({ method: 'PUT', url: '/v1/settings' });
    expect(req.request.body).toEqual({ values: { 'templates.default.pr': 'staging' } });
    req.flush({ settings: [] });
    await r.settle();
    expect((r.byTestId('default-pr') as HTMLSelectElement).value).toBe('staging');
    expect(r.el.textContent).toContain('Pull requests now deploy with Staging');
  });

  it('a key pinned by config is disabled and says so', async () => {
    const r = await open({ templates: two, settings: [setting('templates.default.pr', 'default'), setting('templates.default.api', 'staging', true), setting('templates.default.manual', 'default')] });
    expect((r.byTestId('default-api') as HTMLSelectElement).disabled).toBe(true);
    expect((r.byTestId('default-pr') as HTMLSelectElement).disabled).toBe(false);
    expect(r.text('defaults')).toContain('managed by config');
  });

  it('without settings.write every select is disabled', async () => {
    const ro = await open({ permissions: ['settings.read'], templates: two });
    expect((ro.byTestId('default-pr') as HTMLSelectElement).disabled).toBe(true);
  });

  it('a refused PUT keeps the old value and toasts', async () => {
    const r = await open({ templates: two });
    await choose(r, 'default-api', 'staging');
    r.http.expectOne({ method: 'PUT', url: '/v1/settings' }).flush({ type: 'about:blank', title: 'Unprocessable', status: 422, detail: 'no such template: staging' }, { status: 422, statusText: 'Unprocessable' });
    await r.until(() => (r.el.textContent ?? '').includes('Could not change the default'), 'toast');
    expect(r.el.textContent).toContain('no such template');
  });
});

describe('Settings: global secrets', () => {
  it('the editor talks to /v1/secrets', async () => {
    const r = await open({ globalNames: ['SHARED'] });
    const root = r.byTestId('global-secrets')!;
    expect(Array.from(root.querySelectorAll('[data-testid="secret"]')).map((e) => e.firstChild?.textContent?.trim())).toEqual(['SHARED']);
    const ta = root.querySelector('[data-testid="secret-paste"]') as HTMLTextAreaElement;
    ta.value = 'CLOUDFLARE_API_TOKEN=cf-token\n'; ta.dispatchEvent(new Event('input')); await r.settle();
    ta.closest('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await r.settle();
    const req = r.http.expectOne({ method: 'PATCH', url: '/v1/secrets' });
    expect(req.request.body).toEqual({ set: { CLOUDFLARE_API_TOKEN: { value: 'cf-token', level: 'standard' } } });
    req.flush({ secrets: [{ name: 'CLOUDFLARE_API_TOKEN', level: 'standard' }, { name: 'SHARED', level: 'standard' }] });
    await r.settle();
    expect(root.querySelectorAll('[data-testid="secret"]')).toHaveLength(2);
    expect(r.el.textContent).not.toContain('cf-token');
  });

  it('without repos.secrets there is no editor and no request', async () => {
    const ro = await open({ permissions: ['github.manage'] });
    expect(ro.byTestId('global-secrets')).toBeNull();
  });
});

describe('GitHubCallback', () => {
  const route = (query: Record<string, string>) => ({ provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(query) } } });

  it('exchanges code+state once and moves to /settings', async () => {
    const r = await render(GitHubCallback, { providers: [route({ code: 'c0de', state: 'st4te' })], routes: [{ path: 'settings', children: [] }] });
    expect(r.byTestId('working')).not.toBeNull();
    const req = r.http.expectOne({ method: 'POST', url: '/v1/github/manifest/exchange' });
    expect(req.request.body).toEqual({ code: 'c0de', state: 'st4te' });
    req.flush(status(), { status: 201, statusText: 'Created' });
    await r.until(() => TestBed.inject(Router).url === '/settings', 'navigation');
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

describe('Settings: preview passwords (ADR-0023)', () => {
  const type = async (r: Rendered<unknown>, id: string, v: string) => { const i = r.byTestId(id) as HTMLInputElement; i.value = v; i.dispatchEvent(new Event('input')); await r.settle(); };
  const pwSettings = (mode: string, set: boolean): SettingView[] => [
    setting('previews.password.mode', mode),
    { key: 'previews.password.shared', value: null, source: set ? 'database' : 'default', managedByConfig: false, secret: true, set },
  ];

  it('a first shared password needs a value, is sent to its own route, and is never shown back', async () => {
    const r = await open({ settings: pwSettings('off', false) });
    await choose(r, 'password-default', 'shared');
    expect((r.byTestId('password-save') as HTMLButtonElement).disabled).toBe(true);
    await type(r, 'password-shared', 'p');
    (r.byTestId('password-save') as HTMLButtonElement).click();
    await r.settle();
    const req = r.http.expectOne({ method: 'PUT', url: '/v1/settings/preview-password' });
    expect(req.request.body).toEqual({ mode: 'shared', login: true, value: 'p' });
    req.flush({ settings: pwSettings('shared', true) });
    await r.settle();
    expect((r.byTestId('password-shared') as HTMLInputElement).value).toBe('');
    r.http.verify();
  });

  it('generated: no value, and the help says only new previews change', async () => {
    const r = await open({ settings: pwSettings('shared', true) });
    await choose(r, 'password-default', 'generated');
    expect(r.text('password-help')).toContain('not changed');
    (r.byTestId('password-save') as HTMLButtonElement).click();
    await r.settle();
    const req = r.http.expectOne({ method: 'PUT', url: '/v1/settings/preview-password' });
    expect(req.request.body).toEqual({ mode: 'generated', login: true });
    req.flush({ settings: pwSettings('generated', true) });
    await r.settle();
  });

  it('the login switch alone is a change worth saving: signed-in users need the password too', async () => {
    const r = await open({ settings: [...pwSettings('shared', true), setting('previews.password.login', true)] });
    expect((r.byTestId('password-save') as HTMLButtonElement).disabled).toBe(true);
    const box = r.byTestId('password-login') as HTMLInputElement;
    expect(box.checked).toBe(true);
    box.checked = false; box.dispatchEvent(new Event('change'));
    await r.settle();
    (r.byTestId('password-save') as HTMLButtonElement).click();
    await r.settle();
    const req = r.http.expectOne({ method: 'PUT', url: '/v1/settings/preview-password' });
    expect(req.request.body).toEqual({ mode: 'shared', login: false });
    req.flush({ settings: [...pwSettings('shared', true), setting('previews.password.login', false)] });
    await r.settle();
    expect((r.byTestId('password-login') as HTMLInputElement).checked).toBe(false);
  });
});
