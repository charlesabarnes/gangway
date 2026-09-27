import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { render } from '../../../testing/render';
import type { Permission } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { AdminPage } from './admin-page';

async function open(permissions: Permission[], url = '/admin') {
  const r = await render(AdminPage, { routes: [{ path: 'admin', component: AdminPage }] });
  await TestBed.inject(Router).navigateByUrl(url);
  const loading = TestBed.inject(AuthService).refresh();
  r.http.expectOne('/v1/auth/session').flush({
    authenticated: true,
    setupRequired: false,
    user: { id: 'u1', email: 'ada@example.com', role: { id: 'x', name: 'x' } },
    permissions,
  });
  await loading;
  await r.settle();
  return r;
}

const tabs = (r: { el: HTMLElement }) =>
  Array.from(r.el.querySelectorAll('nav[aria-label="Admin"] a')).map((a) =>
    a.getAttribute('data-testid'),
  );

describe('the Admin page', () => {
  it('shows only the tabs the role may read, opening the first', async () => {
    const r = await open(['roles.read', 'audit.read']);
    expect(tabs(r)).toEqual(['tab-roles', 'tab-audit']);
    expect(r.byTestId('panel-roles')!.hidden).toBe(false);
    r.http.expectOne('/v1/roles');
  });

  it('opens the tab named in the query, and ignores one the role may not see', async () => {
    const audit = await open(['users.read', 'audit.read'], '/admin?tab=audit');
    expect(audit.byTestId('panel-audit')!.hidden).toBe(false);
    expect(audit.byTestId('panel-users')).toBeNull();
    TestBed.resetTestingModule();

    const r = await open(['users.read'], '/admin?tab=roles');
    expect(tabs(r)).toEqual(['tab-users']);
    expect(r.byTestId('panel-users')!.hidden).toBe(false);
  });

  it('shows the server settings as tabs, each loading only what it needs', async () => {
    const r = await open(['settings.read', 'github.manage'], '/admin?tab=domains');
    expect(tabs(r)).toEqual(['tab-previews', 'tab-domains', 'tab-github', 'tab-server']);
    r.http.expectOne('/v1/settings').flush({ settings: [] });
    r.http.expectNone('/v1/templates');
    await r.settle();
    const panel = r.byTestId('panel-domains')!;
    expect(panel.querySelector('app-domain-settings')).not.toBeNull();
    expect(panel.querySelector('app-limit-settings')).not.toBeNull();
    expect(panel.querySelector('app-watermark-settings')).toBeNull();
    expect(panel.querySelector('app-github-settings')).toBeNull();
  });

  it('opens Previews for a role that may only set global secrets', async () => {
    const r = await open(['repos.secrets']);
    expect(tabs(r)).toEqual(['tab-previews']);
    expect(r.byTestId('panel-previews')!.querySelector('app-global-secrets')).not.toBeNull();
  });

  it('says so when there is nothing to show', async () => {
    const r = await open(['previews.read']);
    expect(r.byTestId('no-admin')).not.toBeNull();
  });
});
