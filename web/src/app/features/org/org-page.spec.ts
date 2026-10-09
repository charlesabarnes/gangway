import { render } from '../../../testing/render';
import type { OrgMember, OrgOverview } from '../../core/org.types';
import { OrgPage, formatSize } from './org-page';

const FREE: OrgOverview = {
  org: { id: 'acme', slug: 'acme', name: 'Acme', home: false, state: 'active' },
  planLabel: 'Free',
  limits: { maxSites: 3, storageBytes: 250_000_000, containers: false },
  usage: { sites: 1, apps: 0, storageBytes: 12_500_000, members: 2 },
  billingUrl: 'https://cloud.gangway.sh/billing',
};
const MEMBERS: OrgMember[] = [
  {
    id: 'u1',
    email: 'ada@example.com',
    role: { id: 'r1', name: 'admin' },
    disabled: false,
    invited: false,
    joinedAt: 1,
  },
  {
    id: 'u2',
    email: 'bea@example.com',
    role: { id: 'r2', name: 'viewer' },
    disabled: false,
    invited: true,
    joinedAt: 2,
  },
];

async function page(overview: OrgOverview) {
  const r = await render(OrgPage);
  r.http.expectOne('/v1/org').flush(overview);
  r.http.expectOne('/v1/org/members').flush({ members: MEMBERS });
  await r.settle();
  return r;
}

describe('the org page', () => {
  it('shows the plan, what it allows next to what is used, and a link to change it', async () => {
    const r = await page(FREE);
    expect(r.text('org-name')).toBe('Acme');
    expect(r.text('plan-label')).toBe('Free');
    expect(r.text('meter-sites-value')).toBe('1 of 3');
    expect(r.text('meter-storage-value')).toBe('12.5 MB of 250 MB');
    expect(r.text('meter-members-value')).toBe('2');
    // A static-only plan has no app previews to count.
    expect(r.byTestId('meter-apps')).toBeNull();
    expect(r.byTestId('static-only')).not.toBeNull();
    const manage = r.byTestId('manage-plan')!;
    expect(manage.getAttribute('href')).toBe('https://cloud.gangway.sh/billing');
    expect(manage.getAttribute('rel')).toBe('noopener');
  });

  it('lists the members with their role here and whether they have joined', async () => {
    const r = await page(FREE);
    const rows = r.allByTestId('member-row').map((e) => e.textContent!.replace(/\s+/g, ' ').trim());
    expect(rows).toEqual(['ada@example.com admin Active', 'bea@example.com viewer Invited']);
  });

  it('says there are no limits, and offers no link, where nothing is set', async () => {
    const r = await page({ ...FREE, planLabel: null, limits: null, billingUrl: null });
    expect(r.text('plan-label')).toBe('No plan');
    expect(r.text('meter-apps-value')).toBe('0');
    expect(r.byTestId('manage-plan')).toBeNull();
  });

  it('sizes in the decimal units the server refuses in', () => {
    expect(formatSize(999)).toBe('1 kB');
    expect(formatSize(2_000_000)).toBe('2 MB');
    expect(formatSize(5_000_000_000)).toBe('5 GB');
  });
});
