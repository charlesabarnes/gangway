import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render, type Rendered } from '../../../testing/render';
import type { PermissionInfo, Role } from '../../core/admin.types';
import { PERMISSIONS, type Permission } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { Toasts } from '../../ui/toast';
import { RolesMatrix } from './roles';

@Component({
  imports: [RolesMatrix, Toasts],
  template: '@if (auth.loaded()) {<app-roles-matrix />}<app-toasts />',
})
class Host {
  protected readonly auth = inject(AuthService);
}

const CATALOGUE: PermissionInfo[] = [
  { id: 'previews.read', feature: 'previews', description: 'See previews' },
  { id: 'previews.deploy', feature: 'previews', description: 'Deploy previews' },
  { id: 'users.read', feature: 'users', description: 'See accounts and their roles' },
];
const role = (id: string, permissions: Permission[], editable = true): Role => ({
  id,
  name: id,
  description: '',
  builtin: true,
  createdAt: '2026-01-01T00:00:00Z',
  permissions,
  editable,
});
const ROLES = [
  role('admin', ['previews.deploy', 'previews.read', 'users.read'], false),
  role('member', ['previews.deploy', 'previews.read']),
  role('viewer', ['previews.read']),
];

async function open(permissions: readonly Permission[] = PERMISSIONS) {
  const r = await render(Host);
  const loading = TestBed.inject(AuthService).refresh();
  r.http.expectOne('/v1/auth/session').flush({
    authenticated: true,
    setupRequired: false,
    user: { id: 'u1', email: 'ada@example.com', role: { id: 'admin', name: 'admin' } },
    permissions: [...permissions],
  });
  await loading;
  await r.settle();
  r.http.expectOne('/v1/roles').flush({ roles: ROLES, catalogue: CATALOGUE });
  await r.settle();
  return r;
}

const box = (r: Rendered<unknown>, id: string) => r.byTestId(id) as HTMLInputElement;
const toggle = async (r: Rendered<unknown>, id: string) => {
  box(r, id).click();
  await r.settle();
};

describe('Admin · Roles', () => {
  it('draws the matrix from the server, with admin fixed at everything', async () => {
    const r = await open();
    expect(box(r, 'grant-member-previews.deploy').checked).toBe(true);
    expect(box(r, 'grant-viewer-previews.deploy').checked).toBe(false);
    expect(box(r, 'grant-admin-users.read').checked).toBe(true);
    expect(box(r, 'grant-admin-users.read').disabled).toBe(true);
    expect(box(r, 'grant-viewer-users.read').disabled).toBe(false);
    expect((r.byTestId('roles-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('saves only the roles that changed, in catalogue order', async () => {
    const r = await open();
    await toggle(r, 'grant-viewer-users.read');
    await toggle(r, 'grant-viewer-previews.deploy');
    expect(r.byTestId('dirty-viewer')).not.toBeNull();
    expect(r.byTestId('dirty-member')).toBeNull();
    (r.byTestId('roles-save') as HTMLButtonElement).click();
    const req = r.http.expectOne({ method: 'PUT', url: '/v1/roles/viewer/permissions' });
    expect(req.request.body).toEqual({
      permissions: ['previews.read', 'previews.deploy', 'users.read'],
    });
    req.flush({ role: role('viewer', ['previews.deploy', 'previews.read', 'users.read']) });
    await r.settle();
    // Your own grants may have changed with it.
    r.http.expectOne('/v1/auth/session').flush({
      authenticated: true,
      setupRequired: false,
      user: { id: 'u1', email: 'ada@example.com', role: { id: 'admin', name: 'admin' } },
      permissions: [...PERMISSIONS],
    });
    await r.settle();
    expect(r.byTestId('dirty-viewer')).toBeNull();
    expect((r.byTestId('roles-save') as HTMLButtonElement).disabled).toBe(true);
    r.http.verify();
  });

  it('undo puts the grid back as the server has it', async () => {
    const r = await open();
    await toggle(r, 'grant-member-previews.read');
    expect(box(r, 'grant-member-previews.read').checked).toBe(false);
    (r.byTestId('roles-reset') as HTMLButtonElement).click();
    await r.settle();
    expect(box(r, 'grant-member-previews.read').checked).toBe(true);
    expect(r.byTestId('dirty-member')).toBeNull();
  });

  it('is read-only without roles.manage', async () => {
    const r = await open(['roles.read']);
    expect(r.byTestId('roles-save')).toBeNull();
    expect(box(r, 'grant-member-previews.read').disabled).toBe(true);
    r.http.verify();
  });
});
