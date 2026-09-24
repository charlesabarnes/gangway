import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import contract from '../../../testing/fixtures/contract.json';
import { render, type Rendered } from '../../../testing/render';
import { PERMISSIONS, type ApiToken, type OAuthGrant, type Permission } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { Toasts } from '../../ui/toast';
import { Account } from './account';

@Component({ imports: [Account, Toasts], template: '<app-account /><app-toasts />' })
class Host {}

const MEMBER: Permission[] = [
  'previews.read',
  'logs.read',
  'events.read',
  'hosts.read',
  'previews.read_own',
  'previews.deploy',
  'previews.deploy_static',
  'previews.destroy',
  'previews.destroy_own',
  'previews.update_own',
  'previews.view_private',
  'tokens.manage_own',
];
const token = (over: Partial<ApiToken> = {}): ApiToken => ({
  ...(contract.token as ApiToken),
  ...over,
});

const grant = (over: Partial<OAuthGrant> = {}): OAuthGrant => ({
  ...(contract.oauthGrant as OAuthGrant),
  ...over,
});

async function open(
  o: { permissions?: Permission[]; tokens?: ApiToken[]; grants?: OAuthGrant[]; role?: string } = {},
) {
  const r = await render(Host);
  const loading = TestBed.inject(AuthService).refresh();
  r.http.expectOne('/v1/auth/session').flush({
    authenticated: true,
    setupRequired: false,
    user: {
      id: 'u1',
      email: 'ada@example.com',
      role: { id: o.role ?? 'member', name: o.role ?? 'member' },
    },
    permissions: o.permissions ?? MEMBER,
  });
  await loading;
  await r.settle();
  if ((o.permissions ?? MEMBER).includes('tokens.manage_own')) {
    r.http.expectOne('/v1/tokens').flush({ tokens: o.tokens ?? [] });
    r.http.expectOne('/v1/oauth/grants').flush({ grants: o.grants ?? [] });
    await r.settle();
  }
  return r;
}

const type = (r: Rendered<unknown>, id: string, v: string) => {
  const i = r.byTestId(id) as HTMLInputElement;
  i.value = v;
  i.dispatchEvent(new Event('input'));
};
const check = async (r: Rendered<unknown>, id: string) => {
  (r.byTestId(id) as HTMLInputElement).dispatchEvent(new Event('change'));
  await r.settle();
};
const submit = async (r: Rendered<unknown>, form: string) => {
  r.byTestId(form)!.dispatchEvent(new Event('submit', { cancelable: true }));
  await r.settle();
};

describe('Account', () => {
  beforeAll(installDialogPolyfill);

  it('shows who you are and your permissions by feature, whatever the role is called', async () => {
    const r = await open({ role: 'release-manager' });
    expect(r.text('identity')).toContain('ada@example.com');
    expect(r.text('identity')).toContain('release-manager');
    const granted = Object.fromEntries(
      Array.from(r.byTestId('permissions')!.querySelectorAll('div')).map((d) => [
        d.querySelector('dt')!.textContent,
        d.querySelector('dd')!.textContent,
      ]),
    );
    expect(granted).toEqual({
      events: 'read',
      hosts: 'read',
      logs: 'read',
      previews:
        'deploy, deploy static, destroy, destroy own, read, read own, update own, view private',
      tokens: 'manage own',
    });
  });

  it('the token section and its list appear when the permission is granted later', async () => {
    const r = await open({ permissions: ['previews.read'] });
    expect(r.byTestId('token-form')).toBeNull();
    const again = TestBed.inject(AuthService).refresh();
    r.http
      .expectOne('/v1/auth/session')
      .flush({ authenticated: true, setupRequired: false, permissions: MEMBER });
    await again;
    await r.settle();
    r.http.expectOne('/v1/tokens').flush({ tokens: [token({ name: 'already-there' })] });
    r.http.expectOne('/v1/oauth/grants').flush({ grants: [] });
    await r.settle();
    expect(r.text('tokens')).toContain('already-there');
  });

  it('without tokens.manage_own there is no token section and no token request', async () => {
    const r = await open({ permissions: ['previews.read'] });
    expect(r.byTestId('token-form')).toBeNull();
    r.http.expectNone('/v1/tokens');
  });

  describe('connected agents', () => {
    it('lists each by name and publisher, and disconnecting asks first', async () => {
      const r = await open({ grants: [grant()] });
      expect(r.text('grants')).toContain('Claude');
      expect(r.text('grants')).toContain('claude.ai');
      expect(r.text('grants')).toContain('read, deploy');
      (r.byTestId('disconnect') as HTMLButtonElement).click();
      await r.settle();
      const dialogs = r.el.querySelectorAll('[data-testid="confirm"]');
      const open_ = Array.from(dialogs).find((d) => (d as HTMLDialogElement).open)!;
      expect(open_.textContent).toContain('Disconnect Claude?');
      (open_.querySelector('[data-testid="confirm-ok"]') as HTMLButtonElement).click();
      await r.settle();
      r.http
        .expectOne({ method: 'DELETE', url: `/v1/oauth/grants/${grant().id}` })
        .flush({ grant: grant({ revokedAt: '2026-09-22T13:00:00.000Z' }) });
      await r.settle();
      expect(r.byTestId('no-grants')).not.toBeNull();
    });

    it('with none, says how an agent connects', async () => {
      const r = await open();
      expect(r.text('no-grants')).toContain('connects from its own side');
    });
  });

  describe('tokens', () => {
    it('greys out a scope the role does not fully cover, and says why', async () => {
      const r = await open();
      expect((r.byTestId('scope-read') as HTMLInputElement).disabled).toBe(false);
      expect((r.byTestId('scope-deploy') as HTMLInputElement).disabled).toBe(false);
      // Rebuilding any preview is previews.update, which a member does not hold.
      expect((r.byTestId('scope-update') as HTMLInputElement).disabled).toBe(true);
      expect((r.byTestId('scope-admin') as HTMLInputElement).disabled).toBe(true);
      expect(r.byTestId('token-form')!.textContent).toContain('Your role does not cover this.');
    });

    it('an admin may choose any scope', async () => {
      const r = await open({ permissions: [...PERMISSIONS], role: 'admin' });
      expect((r.byTestId('scope-admin') as HTMLInputElement).disabled).toBe(false);
    });

    it('creates a token and shows the secret once, with a warning, then forgets it', async () => {
      const r = await open();
      const create = () => r.byTestId('create-token') as HTMLButtonElement;
      expect(create().disabled).toBe(true);
      type(r, 'token-name', '  github-actions ');
      await check(r, 'scope-deploy');
      expect(create().disabled).toBe(false);

      await submit(r, 'token-form');
      const req = r.http.expectOne({ method: 'POST', url: '/v1/tokens' });
      expect(req.request.body).toEqual({
        name: 'github-actions',
        scopes: ['deploy'],
        expiresIn: '90d',
      });
      req.flush(
        {
          token: token({ name: 'github-actions' }),
          secret: 'gw_THE_SECRET_VALUE_0123456789abcdefghijklmnop',
        },
        { status: 201, statusText: 'Created' },
      );
      await r.settle();

      expect(r.text('secret')).toBe('gw_THE_SECRET_VALUE_0123456789abcdefghijklmnop');
      expect(r.text('minted')).toContain('will not be shown again');
      expect(r.allByTestId('token')).toHaveLength(1);
      expect(r.byTestId('tokens')!.textContent).not.toContain('THE_SECRET');
      expect((r.byTestId('token-name') as HTMLInputElement).value).toBe('');

      (r.byTestId('done') as HTMLElement).click();
      await r.settle();
      expect(r.el.textContent).not.toContain('THE_SECRET');
    });

    it('"never" sends no expiresIn at all', async () => {
      const r = await open();
      type(r, 'token-name', 'forever');
      await check(r, 'scope-read');
      const sel = r.byTestId('token-expiry') as HTMLSelectElement;
      sel.value = '';
      sel.dispatchEvent(new Event('change'));
      await r.settle();
      await submit(r, 'token-form');
      const req = r.http.expectOne({ method: 'POST', url: '/v1/tokens' });
      expect(req.request.body).toEqual({ name: 'forever', scopes: ['read'] });
      req.flush({ token: token(), secret: 'gw_x' });
    });

    it("a refusal shows the server's reason and asks for permissions again", async () => {
      const r = await open();
      type(r, 'token-name', 'ci');
      await check(r, 'scope-deploy');
      await submit(r, 'token-form');
      r.http
        .expectOne({ method: 'POST', url: '/v1/tokens' })
        .flush(
          { title: 'unprocessable', detail: 'your role does not cover the "deploy" scope' },
          { status: 422, statusText: 'x' },
        );
      await r.until(() => r.byTestId('token-error') !== null, 'the token error');
      expect(r.text('token-error')).toBe('your role does not cover the "deploy" scope');
      r.http.expectOne('/v1/auth/session').flush({
        authenticated: true,
        setupRequired: false,
        permissions: [
          'previews.read',
          'logs.read',
          'events.read',
          'hosts.read',
          'tokens.manage_own',
        ],
      });
      await r.settle();
      expect((r.byTestId('scope-deploy') as HTMLInputElement).disabled).toBe(true);
    });

    it('lists tokens by prefix with last use and expiry; revoking asks first', async () => {
      const r = await open({
        tokens: [
          token({ id: 't1', name: 'ci', lastUsedAt: null, expiresAt: null }),
          token({ id: 't2', name: 'old', revokedAt: '2026-09-01T00:00:00.000Z' }),
        ],
      });
      const rows = r.allByTestId('token');
      expect(rows[0]!.textContent).toContain('gw_2t3Gr_pN…');
      expect(rows[0]!.textContent).toContain('never used');
      expect(rows[0]!.textContent).toContain('no expiry');
      expect(rows[1]!.textContent).toContain('revoked');
      expect(rows[1]!.querySelector('[data-testid="revoke"]')).toBeNull();

      (rows[0]!.querySelector('[data-testid="revoke"]') as HTMLElement).click();
      await r.settle();
      expect(r.byTestId('confirm')!.textContent).toContain('Revoke ci?');
      expect(r.byTestId('confirm')!.textContent).toContain('stops working immediately');
      (r.byTestId('confirm-ok') as HTMLElement).click();
      await r.settle();
      r.http
        .expectOne({ method: 'DELETE', url: '/v1/tokens/t1' })
        .flush({ token: token({ id: 't1', name: 'ci', revokedAt: '2026-09-21T20:00:00.000Z' }) });
      await r.settle();
      expect(r.allByTestId('token')[0]!.querySelector('[data-testid="revoke"]')).toBeNull();
    });
  });

  describe('changing your password', () => {
    const fill = (r: Rendered<unknown>, current: string, next: string, again = next) => {
      type(r, 'current', current);
      type(r, 'next', next);
      type(r, 'again', again);
    };

    it('posts a new password once it is long enough and typed twice, then clears', async () => {
      const r = await open();
      const button = () => r.byTestId('change-password') as HTMLButtonElement;
      fill(r, 'my old password', 'short');
      await r.settle();
      expect(button().disabled).toBe(true);
      fill(r, 'my old password', 'a brand new password', 'a brand new passwork');
      await r.settle();
      expect(button().disabled).toBe(true);
      fill(r, 'my old password', 'a brand new password');
      await r.settle();
      expect(button().disabled).toBe(false);

      await submit(r, 'password-form');
      const req = r.http.expectOne('/v1/auth/password');
      expect(req.request.body).toEqual({
        current: 'my old password',
        next: 'a brand new password',
      });
      req.flush(null, { status: 204, statusText: 'No Content' });
      await r.until(() => r.byTestId('toast') !== null, 'the confirmation');
      expect(r.text('toast')).toContain('other sessions were logged out');
      expect((r.byTestId('current') as HTMLInputElement).value).toBe('');
    });

    it('says when the current password is wrong or the account is locked out', async () => {
      const r = await open();
      fill(r, 'not my password', 'a brand new password');
      await r.settle();
      await submit(r, 'password-form');
      r.http
        .expectOne('/v1/auth/password')
        .flush({ title: 'forbidden' }, { status: 403, statusText: 'x' });
      await r.until(() => r.byTestId('pw-error') !== null, 'the password error');
      expect(r.text('pw-error')).toBe('The current password is wrong.');

      await submit(r, 'password-form');
      r.http
        .expectOne('/v1/auth/password')
        .flush({ title: 'rate limited', retryAfter: 120 }, { status: 429, statusText: 'x' });
      await r.until(() => r.text('pw-error')?.includes('120') === true, 'the lockout message');
    });
  });
});
