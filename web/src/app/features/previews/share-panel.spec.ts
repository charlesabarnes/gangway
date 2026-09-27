import { TestBed } from '@angular/core/testing';
import contract from '../../../testing/fixtures/contract.json';
import { render } from '../../../testing/render';
import type { Preview } from '../../core/api.types';
import type { ShareStatus } from '../../core/share.types';
import { AuthService } from '../../core/auth.service';
import { SharePanel } from './share-panel';

const preview = contract.preview as unknown as Preview;
const url = `/v1/previews/${preview.id}/share`;
const DAY = 86_400_000;
const idle: ShareStatus = { available: true, local: true, maxTtlMs: DAY, share: null };
const shared: ShareStatus = {
  ...idle,
  share: {
    previewId: preview.id,
    url: 'https://cedar-lamp.trycloudflare.com',
    host: 'cedar-lamp.trycloudflare.com',
    provider: 'cloudflare-quick',
    startedAt: 0,
    expiresAt: 4 * 3_600_000,
  },
};

async function open(status: ShareStatus, permissions = ['previews.update', 'previews.share']) {
  const r = await render(SharePanel, { inputs: { preview } });
  const loading = TestBed.inject(AuthService).refresh();
  r.http.expectOne('/v1/auth/session').flush({
    authenticated: true,
    setupRequired: false,
    permissions: ['previews.read', ...permissions],
  });
  await loading;
  await r.settle();
  r.http.expectOne(url).flush(status);
  await r.settle();
  return r;
}

describe('SharePanel', () => {
  it('on a local-only server, offers a link up to the server maximum and starts one', async () => {
    const r = await open(idle);
    expect(r.text('share-intro')).toContain('only on the machine gangway runs on');
    const options = [...(r.byTestId('share-ttl') as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(['1h', '4h', '24h']);

    r.byTestId('share-start')!.click();
    const req = r.http.expectOne({ method: 'POST', url });
    expect(req.request.body).toEqual({ ttl: '4h' });
    req.flush(shared);
    await r.settle();
    expect(r.text('share-url')).toBe('https://cedar-lamp.trycloudflare.com');
    r.http.verify();
  });

  it('stops a link', async () => {
    const r = await open(shared);
    r.byTestId('share-stop')!.click();
    r.http.expectOne({ method: 'DELETE', url }).flush(idle);
    await r.settle();
    expect(r.byTestId('share-url')).toBeNull();
    r.http.verify();
  });

  it('shows a running link, without the controls, to someone who may not share', async () => {
    const r = await open(shared, []);
    expect(r.text('share-url')).toBe('https://cedar-lamp.trycloudflare.com');
    expect(r.byTestId('share-stop')).toBeNull();
    r.http.verify();
  });

  it('stays out of the way on a server that cannot share', async () => {
    const r = await open({ ...idle, available: false });
    expect(r.byTestId('share-panel')).toBeNull();
    r.http.verify();
  });
});
