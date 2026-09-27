import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { render, type Rendered } from '../../../testing/render';
import type { Role, User } from '../../core/admin.types';
import { PERMISSIONS, type Permission } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { Toasts } from '../../ui/toast';
import { UsersList } from './users';

// Mounted once the session is in, as the route guard guarantees in the app.
@Component({
  imports: [UsersList, Toasts],
  template: '@if (auth.loaded()) {<app-users-list />}<app-toasts />',
})
class Host {
  protected readonly auth = inject(AuthService);
}

const role = (id: string, editable = true): Role => ({
  id,
  name: id,
  description: '',
  builtin: true,
  createdAt: '2026-01-01T00:00:00Z',
  permissions: [],
  editable,
});
const ROLES = [role('admin', false), role('member'), role('viewer')];
const user = (over: Partial<User>): User => ({
  id: 'u1',
  email: 'ada@example.com',
  roleId: 'admin',
  disabled: false,
  invited: false,
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});
const ADA = user({});
const BOB = user({ id: 'u2', email: 'bob@example.com', roleId: 'member' });

async function open(
  o: { permissions?: readonly Permission[]; users?: User[]; email?: boolean } = {},
) {
  const r = await render(Host);
  const permissions = o.permissions ?? PERMISSIONS;
  const loading = TestBed.inject(AuthService).refresh();
  r.http.expectOne('/v1/auth/session').flush({
    authenticated: true,
    setupRequired: false,
    user: { id: 'u1', email: 'ada@example.com', role: { id: 'admin', name: 'admin' } },
    permissions: [...permissions],
  });
  await loading;
  await r.settle();
  r.http.expectOne('/v1/users').flush({ users: o.users ?? [ADA, BOB], email: o.email ?? false });
  if (permissions.includes('roles.read')) r.http.expectOne('/v1/roles').flush({ roles: ROLES });
  await r.settle();
  return r;
}

const type = (r: Rendered<unknown>, id: string, v: string) => {
  const i = r.byTestId(id) as HTMLInputElement;
  i.value = v;
  i.dispatchEvent(new Event('input'));
};
const click = async (r: Rendered<unknown>, el: HTMLElement) => {
  el.click();
  await r.settle();
};
const row = (r: Rendered<unknown>, email: string) =>
  r.allByTestId('user-row').find((tr) => tr.textContent!.includes(email))!;

describe('Admin · Users', () => {
  beforeAll(installDialogPolyfill);

  it('lists accounts with role names, status, and marks you', async () => {
    const r = await open({ users: [ADA, { ...BOB, disabled: true }] });
    expect(r.allByTestId('user-row')).toHaveLength(2);
    expect(row(r, 'ada@').querySelector('[data-testid="you"]')).not.toBeNull();
    expect(row(r, 'bob@').querySelector('[data-testid="you"]')).toBeNull();
    const select = row(r, 'bob@').querySelector<HTMLSelectElement>('[data-testid="user-role"]')!;
    expect(select.value).toBe('member');
    expect(row(r, 'bob@').querySelector('[data-testid="user-status"]')!.textContent).toContain(
      'Disabled',
    );
    // You cannot disable yourself from here.
    expect(row(r, 'ada@').querySelector('[data-testid="disable"]')).toBeNull();
    r.http.verify();
  });

  it('adds a user with a generated password and shows it once', async () => {
    const r = await open();
    expect((r.byTestId('new-role') as HTMLSelectElement).value).toBe('member');
    const password = (r.byTestId('new-password') as HTMLInputElement).value;
    expect(password).toHaveLength(20);
    type(r, 'new-email', ' cy@example.com ');
    await r.settle();
    r.byTestId('user-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    const req = r.http.expectOne({ method: 'POST', url: '/v1/users' });
    expect(req.request.body).toEqual({ email: 'cy@example.com', password, roleId: 'member' });
    req.flush(
      { user: user({ id: 'u3', email: 'cy@example.com', roleId: 'member' }) },
      {
        status: 201,
        statusText: 'Created',
      },
    );
    await r.settle();
    expect(r.allByTestId('user-row')).toHaveLength(3);
    expect(r.text('handoff-password')).toBe(password);
    expect((r.byTestId('new-password') as HTMLInputElement).value).not.toBe(password);
    r.http.verify();
  });

  it('with email set up, invites by default and needs no password', async () => {
    const r = await open({ email: true });
    expect(r.byTestId('new-password')!.closest('[hidden]')).not.toBeNull();
    type(r, 'new-email', 'cy@example.com');
    await r.settle();
    expect(r.text('create-user')).toBe('Send invitation');
    r.byTestId('user-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    const req = r.http.expectOne({ method: 'POST', url: '/v1/users' });
    expect(req.request.body).toEqual({ email: 'cy@example.com', roleId: 'member', invite: true });
    req.flush(
      {
        user: user({ id: 'u3', email: 'cy@example.com', roleId: 'member', invited: true }),
        invite: { sent: true },
      },
      { status: 201, statusText: 'Created' },
    );
    await r.settle();
    expect(r.byTestId('handoff')).toBeNull();
    expect(row(r, 'cy@').querySelector('[data-testid="user-status"]')!.textContent).toContain(
      'Invited',
    );
    expect(row(r, 'cy@').querySelector('[data-testid="email-link"]')!.textContent).toContain(
      'Resend invitation',
    );
    r.http.verify();
  });

  it('says when the account was added but the invitation did not go', async () => {
    const r = await open({ email: true });
    type(r, 'new-email', 'cy@example.com');
    await r.settle();
    r.byTestId('user-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    r.http.expectOne({ method: 'POST', url: '/v1/users' }).flush(
      {
        user: user({ id: 'u3', email: 'cy@example.com', roleId: 'member', invited: true }),
        invite: { sent: false, error: 'the mail server refused: Invalid login' },
      },
      { status: 201, statusText: 'Created' },
    );
    await r.settle();
    expect(r.text('user-error')).toContain('the mail server refused: Invalid login');
    expect(r.allByTestId('user-row')).toHaveLength(3);
  });

  it('can still hand over a password when email is set up', async () => {
    const r = await open({ email: true });
    await click(r, r.byTestId('how-password')!);
    expect(r.byTestId('new-password')!.closest('[hidden]')).toBeNull();
    expect(r.text('create-user')).toBe('Add user');
  });

  it('emails an active account a reset link', async () => {
    const r = await open({ email: true });
    await click(r, row(r, 'bob@').querySelector<HTMLElement>('[data-testid="email-link"]')!);
    r.http.expectOne({ method: 'POST', url: '/v1/users/u2/email-link' }).flush({ sent: 'reset' });
    await r.settle();
    r.http.verify();
  });

  it('without email, offers no invitation and no email buttons', async () => {
    const r = await open();
    expect(r.byTestId('invite-choice')).toBeNull();
    expect(r.byTestId('email-link')).toBeNull();
  });

  it('refuses a short password before asking the server', async () => {
    const r = await open();
    type(r, 'new-email', 'cy@example.com');
    type(r, 'new-password', 'short');
    await r.settle();
    expect((r.byTestId('create-user') as HTMLButtonElement).disabled).toBe(true);
  });

  it('changes a role, and puts it back when the server refuses the last admin', async () => {
    const r = await open();
    const select = row(r, 'bob@').querySelector<HTMLSelectElement>('[data-testid="user-role"]')!;
    select.value = 'viewer';
    select.dispatchEvent(new Event('change'));
    const ok = r.http.expectOne({ method: 'PATCH', url: '/v1/users/u2' });
    expect(ok.request.body).toEqual({ roleId: 'viewer' });
    ok.flush({ user: { ...BOB, roleId: 'viewer' } });
    await r.settle();

    const mine = row(r, 'ada@').querySelector<HTMLSelectElement>('[data-testid="user-role"]')!;
    mine.value = 'member';
    mine.dispatchEvent(new Event('change'));
    r.http.expectOne({ method: 'PATCH', url: '/v1/users/u1' }).flush(
      {
        title: 'Conflict',
        status: 409,
        detail: 'this is the last enabled admin; promote or enable another admin first',
      },
      { status: 409, statusText: 'Conflict' },
    );
    await r.settle();
    expect(mine.value).toBe('admin');
    expect(r.el.textContent).toContain('last enabled admin');
    r.http.verify();
  });

  it('disables after confirming, and enables without asking', async () => {
    const r = await open();
    await click(r, row(r, 'bob@').querySelector<HTMLElement>('[data-testid="disable"]')!);
    await click(r, r.byTestId('confirm-ok')!);
    const off = r.http.expectOne({ method: 'PATCH', url: '/v1/users/u2' });
    expect(off.request.body).toEqual({ disabled: true });
    off.flush({ user: { ...BOB, disabled: true } });
    await r.settle();

    await click(r, row(r, 'bob@').querySelector<HTMLElement>('[data-testid="enable"]')!);
    const on = r.http.expectOne({ method: 'PATCH', url: '/v1/users/u2' });
    expect(on.request.body).toEqual({ disabled: false });
    on.flush({ user: BOB });
    await r.settle();
    r.http.verify();
  });

  it('resets a password to a generated one and shows it to hand over', async () => {
    const r = await open();
    await click(r, row(r, 'bob@').querySelector<HTMLElement>('[data-testid="reset-password"]')!);
    await click(r, r.byTestId('confirm-ok')!);
    const req = r.http.expectOne({ method: 'PATCH', url: '/v1/users/u2' });
    const { password } = req.request.body as { password: string };
    expect(password).toHaveLength(20);
    req.flush({ user: BOB });
    await r.settle();
    expect(r.text('handoff-password')).toBe(password);
    r.http.verify();
  });

  it('is read-only with users.read alone, naming roles by id without roles.read', async () => {
    const r = await open({ permissions: ['users.read'] });
    expect(r.byTestId('user-form')).toBeNull();
    expect(r.byTestId('disable')).toBeNull();
    expect(row(r, 'bob@').querySelector('[data-testid="user-role"]')!.textContent).toBe('member');
    r.http.verify();
  });
});
