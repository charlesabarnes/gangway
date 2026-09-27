import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '../../../testing/render';
import type { AuditEntry } from '../../core/admin.types';
import { PERMISSIONS, type Permission } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { AuditLog } from './audit';

@Component({
  imports: [AuditLog],
  template: '@if (auth.loaded()) {<app-audit-log />}',
})
class Host {
  protected readonly auth = inject(AuthService);
}

const entry = (seq: number, over: Partial<AuditEntry> = {}): AuditEntry => ({
  seq,
  actorType: 'user',
  actorId: 'u1',
  action: 'user.created',
  target: 'u2',
  old: null,
  new: { email: 'bob@example.com', roleId: 'member' },
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

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
  return r;
}

const page = (url: string) => (req: { url: string; params: { toString(): string } }) =>
  req.url === '/v1/audit' && req.params.toString() === url;

describe('Admin · Audit log', () => {
  it('names users by email, pages back with before, and filters by action', async () => {
    const r = await open();
    r.http.expectOne(page('limit=50')).flush({
      entries: [entry(3), entry(2, { actorType: 'system', actorId: null, action: 'boot' })],
      nextBefore: 2,
    });
    r.http.expectOne('/v1/users').flush({
      users: [
        { id: 'u1', email: 'ada@example.com' },
        { id: 'u2', email: 'bob@example.com' },
      ],
    });
    await r.settle();
    const who = r.allByTestId('audit-who').map((e) => e.textContent!.trim());
    expect(who).toEqual(['ada@example.com', 'gangway']);
    expect(r.el.textContent).toContain('"roleId":"member"');

    r.byTestId('audit-more')!.click();
    r.http.expectOne(page('limit=50&before=2')).flush({ entries: [entry(1)], nextBefore: null });
    await r.settle();
    expect(r.allByTestId('audit-entry')).toHaveLength(3);
    expect(r.byTestId('audit-more')).toBeNull();

    const input = r.byTestId('audit-action') as HTMLInputElement;
    input.value = 'boot';
    input.dispatchEvent(new Event('input'));
    r.byTestId('audit-filter')!.click();
    r.http.expectOne(page('limit=50&action=boot')).flush({ entries: [], nextBefore: null });
    await r.settle();
    expect(r.text('audit-empty')).toBe('Nothing recorded for boot.');
    r.http.verify();
  });

  it('shows ids when it may not read users', async () => {
    const r = await open(['audit.read']);
    r.http.expectOne(page('limit=50')).flush({ entries: [entry(1)], nextBefore: null });
    await r.settle();
    expect(r.text('audit-who')).toBe('u1');
    r.http.verify();
  });
});
