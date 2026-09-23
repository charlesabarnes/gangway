import { TestBed } from '@angular/core/testing';
import { render } from '../../../testing/render';
import type { DataResult, Permission, PreviewAddon } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { DbBrowser } from './db-browser';

const ID = '01WORKSPACE000000000000000';

describe('DbBrowser', () => {
  const ADDONS: PreviewAddon[] = [{ id: 'postgres', version: '18', name: 'PostgreSQL', service: 'postgres', env: ['DATABASE_URL'] }];
  const RESULT: DataResult = { columns: ['n', 'note'], rows: [['1', null]], truncated: false, message: null, ms: 7 };

  async function open(permissions: Permission[]) {
    const r = await render(DbBrowser, { inputs: { previewId: ID } });
    const loading = TestBed.inject(AuthService).refresh();
    r.http.expectOne('/v1/auth/session').flush({ authenticated: true, setupRequired: false, permissions });
    await loading;
    await r.settle();
    return r;
  }

  it('without previews.data it says so and reads no data', async () => {
    const r = await open(['previews.read']);
    r.http.expectOne(`/v1/previews/${ID}/addons`).flush({ addons: ADDONS });
    await r.settle();
    expect(r.byTestId('db-no-permission')).not.toBeNull();
    r.http.verify();
  });

  it('lists tables, pages rows, shows NULL as NULL, runs the console read-only unless writes are on', async () => {
    const r = await open(['previews.read', 'previews.data']);
    r.http.expectOne(`/v1/previews/${ID}/addons`).flush({ addons: ADDONS });
    await r.settle();
    r.http.expectOne(`/v1/previews/${ID}/addons/postgres/tables`).flush({ tables: [{ schema: 'public', name: 'visits' }] });
    await r.settle();
    expect(r.allByTestId('db-table').map((e) => e.textContent!.trim())).toEqual(['visits']);

    r.byTestId('db-table')!.click();
    await r.settle();
    const rows = r.http.expectOne((q) => q.url === `/v1/previews/${ID}/addons/postgres/rows`);
    expect(rows.request.params.get('table')).toBe('visits');
    expect(rows.request.params.get('offset')).toBe('0');
    rows.flush({ ...RESULT, rows: Array.from({ length: 50 }, (_, i) => [String(i), null]) });
    await r.settle();
    expect(r.el.querySelector('[data-testid="db-grid"] td:nth-child(2)')!.textContent!.trim()).toBe('NULL');
    r.byTestId('db-next')!.click();
    await r.settle();
    const page2 = r.http.expectOne((q) => q.url.endsWith('/rows'));
    expect(page2.request.params.get('offset')).toBe('50');
    page2.flush(RESULT);
    await r.settle();

    const text = r.byTestId('db-text') as HTMLTextAreaElement;
    text.value = 'select 1';
    text.dispatchEvent(new Event('input'));
    text.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
    await r.settle();
    const q = r.http.expectOne(`/v1/previews/${ID}/addons/postgres/query`);
    expect(q.request.body).toEqual({ text: 'select 1', write: false });
    q.flush({ title: 'unprocessable', detail: 'ERROR:  cannot execute INSERT in a read-only transaction' }, { status: 422, statusText: 'x' });
    await r.settle();
    expect(r.text('db-error')).toContain('read-only transaction');

    (r.byTestId('db-write') as HTMLInputElement).click();
    await r.settle();
    r.byTestId('db-run')!.click();
    await r.settle();
    const w = r.http.expectOne(`/v1/previews/${ID}/addons/postgres/query`);
    expect(w.request.body.write).toBe(true);
    w.flush(RESULT);
    await r.settle();
    // A write may have made a table: listed again.
    r.http.expectOne(`/v1/previews/${ID}/addons/postgres/tables`).flush({ tables: [{ schema: 'public', name: 'visits' }, { schema: 'public', name: 'notes' }] });
    await r.settle();
    expect(r.allByTestId('db-table')).toHaveLength(2);
    r.http.verify();
  });
});
