import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import contract from '../../../testing/fixtures/contract.json';
import { render, type Rendered } from '../../../testing/render';
import { PERMISSIONS, type Permission, type Repo, type Template } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { Toasts } from '../../ui/toast';
import { ReposPage } from './repos';

@Component({ imports: [ReposPage, Toasts], template: '<app-repos /><app-toasts />' })
class Host {}

const repo = (over: Partial<Repo> = {}): Repo => ({ ...(contract.repo as Repo), ...over });
const template = (over: Partial<Template> = {}): Template => ({ ...(contract.template as Template), ...over });
const TEMPLATES = [template(), template({ id: 'staging', name: 'Staging', builtin: false })];

async function open(o: { permissions?: Permission[]; repos?: Repo[]; secretNames?: Record<string, string[]> } = {}) {
  const r = await render(Host);
  const perms = o.permissions ?? [...PERMISSIONS];
  const loading = TestBed.inject(AuthService).refresh();
  r.http.expectOne('/v1/auth/session').flush({ authenticated: true, setupRequired: false, user: { id: 'u1', email: 'ada@example.com', role: { id: 'admin', name: 'admin' } }, permissions: perms });
  await loading;
  await r.settle();
  r.http.expectOne('/v1/repos').flush({ repos: o.repos ?? [] });
  r.http.expectOne('/v1/templates').flush({ templates: TEMPLATES });
  await r.settle();
  if (perms.includes('repos.secrets')) {
    for (const repo of o.repos ?? []) r.http.expectOne(`/v1/repos/${repo.id}/env`).flush({ secrets: (o.secretNames?.[repo.id] ?? []).map((name) => ({ name, level: 'high' })) });
  }
  await r.settle();
  return r;
}

const type = (r: Rendered<unknown>, id: string, v: string) => { const i = r.byTestId(id) as HTMLInputElement; i.value = v; i.dispatchEvent(new Event('input')); };
const choose = async (r: Rendered<unknown>, id: string, v: string) => { const s = r.byTestId(id) as HTMLSelectElement; s.value = v; s.dispatchEvent(new Event('change')); await r.settle(); };
const submit = async (r: Rendered<unknown>, id: string) => { r.byTestId('form-' + id)!.dispatchEvent(new Event('submit', { cancelable: true })); await r.settle(); };

describe('Repositories', () => {
  it('without repos.manage: the list, read-only, with the template chip', async () => {
    const r = await open({ permissions: ['previews.read'], repos: [repo(), repo({ id: 'r2', fullName: 'acme/other', slug: 'other', templateId: 'staging' })] });
    expect(r.allByTestId('repo')).toHaveLength(2);
    expect(r.byTestId('slug')).toBeNull();
    expect(r.allByTestId('template-chip').map((e) => e.textContent?.trim())).toEqual(['PR default', 'Staging']);
    expect(r.byTestId('secrets-' + repo().id)).toBeNull();
  });

  it('a repository is edited in a draft and saved as a PATCH of only what changed; a disabled one says why', async () => {
    const r = await open({ repos: [repo(), repo({ id: 'r2', fullName: 'other/web-app', slug: 'web-app-x1y2z3', enabled: false, disabledReason: 'slug "web-app" is taken by acme/web-app' })] });
    expect(r.allByTestId('why')[0]!.textContent).toContain('taken by acme/web-app');
    const save = () => r.allByTestId('save')[1] as HTMLButtonElement;
    expect(save().disabled).toBe(true);

    type(r, 'slug', 'ignored-first-row'); // the FIRST row's slug: must not leak into the second row's patch
    const second = r.allByTestId('repo')[1]!;
    const slug = second.querySelector('[data-testid="slug"]') as HTMLInputElement; slug.value = 'legacy'; slug.dispatchEvent(new Event('input'));
    const enabled = second.querySelector('[data-testid="enabled"]') as HTMLInputElement; enabled.checked = true; enabled.dispatchEvent(new Event('change'));
    const forks = second.querySelector('[data-testid="forks"]') as HTMLSelectElement; forks.value = 'auto'; forks.dispatchEvent(new Event('change'));
    const tpl = second.querySelector('[data-testid="template"]') as HTMLSelectElement; tpl.value = 'staging'; tpl.dispatchEvent(new Event('change'));
    await r.settle();
    expect(save().disabled).toBe(false);
    await submit(r, 'r2');
    const req = r.http.expectOne({ method: 'PATCH', url: '/v1/repos/r2' });
    expect(req.request.body).toEqual({ slug: 'legacy', enabled: true, forks: 'auto', templateId: 'staging' });
    req.flush({ repo: repo({ id: 'r2', fullName: 'other/web-app', slug: 'legacy', enabled: true, forks: 'auto', templateId: 'staging' }) });
    await r.settle();
    expect(r.allByTestId('disabled')).toHaveLength(0);
    expect(r.allByTestId('repo')[1]!.textContent).toContain('legacy-pr-');
    expect(r.allByTestId('template-chip')[1]!.textContent?.trim()).toBe('Staging');
    expect(save().disabled).toBe(true);
  });

  it('"the template\'s" is sent as null for visibility, the PR clearance and the template itself', async () => {
    const r = await open({ repos: [repo({ visibility: 'public', prClearance: 'high', templateId: 'staging' })] });
    await choose(r, 'visibility', '');
    await choose(r, 'pr-clearance', '');
    await choose(r, 'template', '');
    await submit(r, repo().id);
    expect(r.http.expectOne({ method: 'PATCH', url: `/v1/repos/${repo().id}` }).request.body).toEqual({ visibility: null, prClearance: null, templateId: null });
  });

  it('a 409 on the slug is shown on that row', async () => {
    const r = await open({ repos: [repo()] });
    type(r, 'slug', 'taken'); await r.settle();
    await submit(r, repo().id);
    r.http.expectOne({ method: 'PATCH', url: `/v1/repos/${repo().id}` }).flush({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'slug "taken" is taken by other/x' }, { status: 409, statusText: 'Conflict' });
    await r.until(() => r.byTestId('row-error') !== null, 'row error');
    expect(r.text('row-error')).toContain('taken by other/x');
  });

  it('empty: says no pull requests have arrived', async () => {
    const r = await open();
    expect(r.byTestId('no-repos')).not.toBeNull();
  });
});

describe('a repository\'s secrets', () => {
  const inRepo = (r: Rendered<unknown>, id: string) => {
    const root = r.byTestId('secrets-' + id)!;
    return { q: (sel: string) => root.querySelector(sel) as HTMLElement, all: (sel: string) => Array.from(root.querySelectorAll(sel)) as HTMLElement[] };
  };
  const typeIn = (el: HTMLElement, v: string) => { (el as HTMLInputElement).value = v; el.dispatchEvent(new Event('input')); };

  it('lists names as chips with their level (never a value), sets one with a PATCH, re-levels, removes one with an unset', async () => {
    const r = await open({ repos: [repo()], secretNames: { [repo().id]: ['FONTAWESOME_TOKEN'] } });
    const ed = inRepo(r, repo().id);
    expect(ed.all('[data-testid="secret"]').map((e) => e.firstChild?.textContent?.trim())).toEqual(['FONTAWESOME_TOKEN']);
    expect((ed.q('[data-testid="level"]') as HTMLSelectElement).value).toBe('high');
    const sel = ed.q('[data-testid="level"]') as HTMLSelectElement; sel.value = 'low'; sel.dispatchEvent(new Event('change')); await r.settle();
    const rl = r.http.expectOne({ method: 'PATCH', url: `/v1/repos/${repo().id}/env` });
    expect(rl.request.body).toEqual({ levels: { FONTAWESOME_TOKEN: 'low' } });
    rl.flush({ secrets: [{ name: 'FONTAWESOME_TOKEN', level: 'low' }] }); await r.settle();

    expect((ed.q('[data-testid="set-secret"]') as HTMLButtonElement).disabled).toBe(true);
    typeIn(ed.q('[data-testid="secret-name"]'), 'API_KEY'); typeIn(ed.q('[data-testid="secret-value"]'), 's3cret'); await r.settle();
    expect((ed.q('[data-testid="set-secret"]') as HTMLButtonElement).disabled).toBe(false);
    ed.q('[data-testid="secret-name"]').closest('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await r.settle();
    const req = r.http.expectOne({ method: 'PATCH', url: `/v1/repos/${repo().id}/env` });
    expect(req.request.body).toEqual({ set: { API_KEY: { value: 's3cret', level: 'standard' } } });
    req.flush({ secrets: [{ name: 'API_KEY', level: 'standard' }, { name: 'FONTAWESOME_TOKEN', level: 'low' }] });
    await r.settle();
    expect(ed.all('[data-testid="secret"]')).toHaveLength(2);
    expect(r.el.textContent).not.toContain('s3cret');
    expect((ed.q('[data-testid="secret-value"]') as HTMLInputElement).value).toBe('');

    (ed.all('[data-testid="unset"]')[0] as HTMLButtonElement).click(); await r.settle();
    const un = r.http.expectOne({ method: 'PATCH', url: `/v1/repos/${repo().id}/env` });
    expect(un.request.body).toEqual({ unset: ['API_KEY'] });
    un.flush({ secrets: [{ name: 'FONTAWESOME_TOKEN', level: 'low' }] });
    await r.settle();
    expect(ed.all('[data-testid="secret"]')).toHaveLength(1);
  });

  it('a pasted .env becomes one PATCH at the chosen level: comments and blanks skipped, quotes removed, the textarea cleared', async () => {
    const r = await open({ repos: [repo()] });
    const ed = inRepo(r, repo().id);
    const lv = ed.q('[data-testid="pasted-level"]') as HTMLSelectElement; lv.value = 'high'; lv.dispatchEvent(new Event('change')); await r.settle();
    const ta = ed.q('[data-testid="secret-paste"]') as HTMLTextAreaElement;
    ta.value = '# staging\nexport DB_HOST=db.example\nJWT_SECRET="a b" # trailing\nEMPTY=\nbad-name=x\nPORT=3000 # comment\n\n'; ta.dispatchEvent(new Event('input')); await r.settle();
    expect(ed.q('[data-testid="set-pasted"]').textContent).toContain('Set 4 variables');
    ta.closest('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await r.settle();
    const req = r.http.expectOne({ method: 'PATCH', url: `/v1/repos/${repo().id}/env` });
    const at = (value: string) => ({ value, level: 'high' });
    expect(req.request.body).toEqual({ set: { DB_HOST: at('db.example'), JWT_SECRET: at('a b'), EMPTY: at(''), PORT: at('3000') } });
    req.flush({ secrets: ['DB_HOST', 'EMPTY', 'JWT_SECRET', 'PORT'].map((name) => ({ name, level: 'high' })) });
    await r.settle();
    expect(ed.all('[data-testid="secret"]')).toHaveLength(4);
    expect((ed.q('[data-testid="secret-paste"]') as HTMLTextAreaElement).value).toBe('');
  });

  it('a bad name keeps the button disabled', async () => {
    const r = await open({ repos: [repo()] });
    const ed = inRepo(r, repo().id);
    typeIn(ed.q('[data-testid="secret-name"]'), '1bad'); typeIn(ed.q('[data-testid="secret-value"]'), 'x'); await r.settle();
    expect((ed.q('[data-testid="set-secret"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('without repos.secrets there is no editor and no request', async () => {
    const ro = await open({ permissions: ['previews.read', 'repos.manage'], repos: [repo()] });
    expect(ro.byTestId('secrets-' + repo().id)).toBeNull();
    ro.http.expectNone(`/v1/repos/${repo().id}/env`);
  });
});
