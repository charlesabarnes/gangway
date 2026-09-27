import { TestBed } from '@angular/core/testing';
import contract from '../../../testing/fixtures/contract.json';
import { render } from '../../../testing/render';
import type { Preview } from '../../core/api.types';
import type { DomainClaim, PreviewDomains } from '../../core/domain.types';
import { AuthService } from '../../core/auth.service';
import { DomainPanel } from './domain-panel';

const preview = {
  ...(contract.preview as unknown as Preview),
  urls: [{ service: 'web', url: 'https://shop.preview.example.com/', primary: true }],
};
const claim: DomainClaim = {
  id: 'd1',
  name: 'www.shop.example',
  kind: 'exact',
  projectId: null,
  previewId: preview.id,
  status: 'pending',
  claimId: 'c1',
  routingOk: false,
  lastError: null,
  checkedAt: null,
  verifiedAt: null,
  createdBy: null,
  createdAt: '2026-09-26T00:00:00.000Z',
  updatedAt: '2026-09-26T00:00:00.000Z',
  records: [
    { type: 'CNAME', name: '_acme-challenge.www.shop.example', value: 'c1.acme.x', purpose: 'p' },
    { type: 'CNAME', name: 'www.shop.example', value: 'x', purpose: 'q' },
  ],
};

async function open(listing: PreviewDomains) {
  const r = await render(DomainPanel, { inputs: { preview } });
  const loading = TestBed.inject(AuthService).refresh();
  r.http.expectOne('/v1/auth/session').flush({
    authenticated: true,
    setupRequired: false,
    permissions: ['previews.read', 'previews.update', 'previews.domain'],
  });
  await loading;
  await r.settle();
  r.http.expectOne(`/v1/previews/${preview.id}/domains`).flush(listing);
  await r.settle();
  return r;
}

describe('DomainPanel', () => {
  it('lists a claim with its records, once', async () => {
    const r = await open({
      available: ['preview.example.com', 'alt.example.com'],
      current: 'alt.example.com',
      domains: [claim],
    });
    expect(r.text('domain-state')).toBe('Waiting for DNS');
    expect(r.allByTestId('domain-records')).toHaveLength(1);
    expect(r.text('domain-moving')).toContain('alt.example.com');
    r.http.verify();
  });
});
