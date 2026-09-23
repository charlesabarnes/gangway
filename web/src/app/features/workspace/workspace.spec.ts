import { TestBed } from '@angular/core/testing';
import { render } from '../../../testing/render';
import type { DataResult, Permission, PreviewAddon } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import type { RedeployEvent } from '../previews/previews.store';
import { DbBrowser } from './db-browser';
import { PreviewFrame } from './preview-frame';

const ID = '01WORKSPACE000000000000000';

describe('PreviewFrame', () => {
  const redeploy = (phase: 'started' | 'succeeded' | 'failed', buildId: string) =>
    ({ type: 'preview.redeploy', previewId: ID, seq: 1, at: '', phase, buildId, by: 'x' }) as unknown as RedeployEvent;

  it('frames the real URL in a sandbox without top navigation, and reloads once when a rebuild goes live', async () => {
    const r = await render(PreviewFrame, { inputs: { url: 'https://site.preview.localhost:8443/', state: 'awake' } });
    const frame = r.byTestId('frame') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).not.toContain('allow-top-navigation');
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
    expect(frame.src).toBe('https://site.preview.localhost:8443/');

    r.fixture.componentRef.setInput('redeploy', redeploy('started', 'b1'));
    await r.settle();
    expect(r.text('frame-overlay')).toContain('Rebuilding');
    expect((r.byTestId('frame') as HTMLIFrameElement).src).toBe('https://site.preview.localhost:8443/');

    r.fixture.componentRef.setInput('redeploy', redeploy('succeeded', 'b1'));
    await r.settle();
    expect(r.byTestId('frame-overlay')).toBeNull();
    const reloaded = (r.byTestId('frame') as HTMLIFrameElement).src;
    expect(reloaded).toBe('https://site.preview.localhost:8443/?_gw=1');
    // The same event again is not a new rebuild.
    r.fixture.componentRef.setInput('state', 'awake');
    await r.settle();
    expect((r.byTestId('frame') as HTMLIFrameElement).src).toBe(reloaded);
  });

  it('the path box navigates within the preview, and cannot leave its origin', async () => {
    const r = await render(PreviewFrame, { inputs: { url: 'https://site.preview.localhost:8443/', state: 'awake' } });
    const box = r.byTestId('frame-path') as HTMLInputElement;
    const go = async (v: string) => { box.value = v; box.dispatchEvent(new Event('input')); box.form!.dispatchEvent(new Event('submit')); await r.settle(); };
    await go('/api/time');
    expect((r.byTestId('frame') as HTMLIFrameElement).src).toBe('https://site.preview.localhost:8443/api/time?_gw=1');
    await go('//evil.example/x');
    expect((r.byTestId('frame') as HTMLIFrameElement).src).toMatch(/^https:\/\/site\.preview\.localhost:8443\/\?_gw=/);
    await go('javascript:alert(1)');
    expect((r.byTestId('frame') as HTMLIFrameElement).src).toMatch(/^https:\/\/site\.preview\.localhost:8443\//);
  });

  it('coming back up (asleep -> awake) reloads too', async () => {
    const r = await render(PreviewFrame, { inputs: { url: 'https://site.preview.localhost:8443/', state: 'starting' } });
    expect(r.text('frame-overlay')).toContain('Starting');
    r.fixture.componentRef.setInput('state', 'awake');
    await r.settle();
    expect((r.byTestId('frame') as HTMLIFrameElement).src).toContain('_gw=1');
  });
});

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
