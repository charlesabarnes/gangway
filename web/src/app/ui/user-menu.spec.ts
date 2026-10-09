import { TestBed } from '@angular/core/testing';
import { render } from '../../testing/render';
import type { Permission } from '../core/api.types';
import { HARD_NAVIGATE } from '../core/auth.guard';
import { AuthService } from '../core/auth.service';
import type { MyOrg } from '../core/org.types';
import { UserMenu } from './user-menu';

const ADA = { id: 'u1', email: 'ada@example.com', role: { id: 'admin', name: 'admin' } };
const HOME: MyOrg = {
  id: 'home',
  slug: 'default',
  name: 'Default',
  home: true,
  state: 'active',
  role: { id: 'admin', name: 'admin' },
  current: true,
};
const ACME: MyOrg = {
  id: 'acme',
  slug: 'acme',
  name: 'Acme',
  home: false,
  state: 'active',
  role: { id: 'r2', name: 'viewer' },
  current: false,
};

async function menu(orgs: MyOrg[], permissions: Permission[] = ['previews.read']) {
  const went: string[] = [];
  const r = await render(UserMenu, {
    inputs: { user: ADA },
    providers: [{ provide: HARD_NAVIGATE, useValue: (url: string) => went.push(url) }],
  });
  const loading = TestBed.inject(AuthService).refresh();
  r.http
    .expectOne('/v1/auth/session')
    .flush({ authenticated: true, setupRequired: false, user: ADA, permissions });
  await loading;
  r.byTestId('who')!.click();
  await r.settle();
  r.http.expectOne('/v1/me/orgs').flush({ orgs });
  await r.settle();
  return { r, went };
}

describe('the org switcher in the user menu', () => {
  it('is not there for someone in one org, and neither is the org page', async () => {
    const { r } = await menu([HOME], ['previews.read', 'org.read']);
    expect(r.byTestId('org-switcher')).toBeNull();
    expect(r.byTestId('menu-org')).toBeNull();
  });

  it('lists every org with the current one marked and the role in the others', async () => {
    const { r } = await menu([HOME, ACME]);
    const options = r.allByTestId('org-option');
    const spans = (o: HTMLElement) =>
      Array.from(o.querySelectorAll('span')).map((s) => s.textContent!.trim());
    expect(options.map(spans)).toEqual([['Default'], ['Acme', 'viewer']]);
    expect(options[0]!.getAttribute('aria-current')).toBe('true');
    expect((options[0] as HTMLButtonElement).disabled).toBe(true);
    expect(r.byTestId('menu-org')).toBeNull();
  });

  it('moves the session and reloads the app in the new org', async () => {
    const { r, went } = await menu([HOME, ACME], ['previews.read', 'org.read']);
    expect(r.byTestId('menu-org')!.getAttribute('href')).toBe('/org');
    r.allByTestId('org-option')[1]!.click();
    const req = r.http.expectOne('/v1/session/org');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ orgId: 'acme' });
    req.flush({ org: { ...ACME, current: true } });
    await r.until(() => went.length > 0, 'a full load');
    expect(went).toEqual(['/previews']);
  });

  it('stays put and can try again when the server refuses', async () => {
    const { r, went } = await menu([HOME, ACME]);
    r.allByTestId('org-option')[1]!.click();
    r.http
      .expectOne('/v1/session/org')
      .flush(
        { title: 'not found', status: 404, detail: 'no such org' },
        { status: 404, statusText: 'x' },
      );
    await r.settle();
    expect(went).toEqual([]);
    expect((r.allByTestId('org-option')[1] as HTMLButtonElement).disabled).toBe(false);
  });
});
