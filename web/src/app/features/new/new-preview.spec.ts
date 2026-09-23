import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { gunzipSync, strToU8 } from 'fflate';
import contract from '../../../testing/fixtures/contract.json';
import { render } from '../../../testing/render';
import type { AppPlan, Permission, Preview, RuntimeList } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { NewPreview } from './new-preview';
import { finish } from './pack';

@Component({ template: '' })
class Blank {}

const RUNTIMES: RuntimeList = {
  runtimes: [
    { id: 'static', name: 'Static site', language: 'HTML', description: 'nginx', image: 'nginx', port: 8080, starter: { 'index.html': '<h1>hi</h1>' }, versions: ['1.29'] },
    { id: 'bun', name: 'TypeScript on Bun', language: 'TypeScript', description: 'bun', image: 'oven/bun', port: 3000, starter: { 'index.ts': 'export default {};' }, versions: ['1.4'] },
    { id: 'node', name: 'Node.js', language: 'JavaScript', description: 'node', image: 'node', port: 3000, starter: { 'server.js': '' }, versions: ['24', '22', '20'] },
  ],
  detection: [{ runtime: 'own', markers: ['Dockerfile'] }, { runtime: 'node', markers: ['package.json'] }, { runtime: 'bun', markers: ['index.ts'] }],
  planFiles: ['gangway.yml', 'package.json', 'Procfile'],
  addons: [
    { id: 'postgres', name: 'PostgreSQL', description: 'pg', versions: ['16', '17', '18'], defaultVersion: '18', env: ['DATABASE_URL'] },
    { id: 'redis', name: 'Redis', description: 'redis', versions: ['8'], defaultVersion: '8', env: ['REDIS_URL'] },
  ],
};

async function open(permissions: Permission[] = ['previews.read', 'previews.deploy']) {
  const r = await render(NewPreview, { routes: [{ path: '**', component: Blank }] });
  const loading = TestBed.inject(AuthService).refresh();
  r.http.expectOne('/v1/auth/session').flush({ authenticated: true, setupRequired: false, permissions });
  await loading;
  await r.settle();
  if (permissions.includes('previews.deploy')) {
    r.http.expectOne('/v1/runtimes').flush(RUNTIMES);
    await r.settle();
    r.http.expectOne('/v1/projects').flush({ projects: [] });
    r.http.expectOne('/v1/templates').flush({ templates: [] });
    await r.settle();
  }
  return r;
}

const gunzipText = async (body: unknown) => new TextDecoder().decode(gunzipSync(new Uint8Array(await (body as Blob).arrayBuffer())));

describe('NewPreview', () => {
  it('without previews.deploy it says so and asks for nothing', async () => {
    const r = await open(['previews.read']);
    expect(r.byTestId('no-permission')).not.toBeNull();
    r.http.verify();
  });

  it('a runtime card posts its starter as a gzipped tar with ?runtime=, and lands on the new preview', async () => {
    const r = await open();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    expect(r.allByTestId('starter-bun')).toHaveLength(1);
    // Every card carries its runtime's mark, so they can be told apart at a glance.
    for (const id of ['static', 'bun', 'node']) expect(r.byTestId(`starter-${id}`)!.querySelector('svg path')!.getAttribute('d')!.length).toBeGreaterThan(20);
    r.byTestId('starter-bun')!.click();
    await r.settle();

    const req = r.http.expectOne((q) => q.url.startsWith('/v1/previews'));
    expect(req.request.method).toBe('POST');
    expect(req.request.urlWithParams).toBe('/v1/previews?runtime=bun');
    expect(req.request.headers.get('content-type')).toBe('application/gzip');
    expect(await gunzipText(req.request.body)).toContain('export default {};');
    req.flush({ preview: { ...(contract.preview as Preview), id: '01NEWPREVIEW0000000000000A' } }, { status: 202, statusText: 'Accepted' });
    await r.until(() => navigate.mock.calls.length > 0, 'navigation');
    expect(navigate).toHaveBeenCalledWith(['/previews', '01NEWPREVIEW0000000000000A', 'edit']);
    r.http.verify();
  });

  it('dropped files show a summary and the detected runtime; the choice can be overridden; options ride the query', async () => {
    const r = await open();
    await r.fixture.componentInstance.accept(finish([
      { path: 'api/package.json', data: strToU8('{}') }, { path: 'api/server.js', data: strToU8('x') }, { path: 'api/.DS_Store', data: strToU8('') },
    ]));
    await r.settle();
    expect(r.text('summary')).toContain('2 files');
    expect(r.text('summary')).toContain('1 skipped');
    expect(r.text('detected')).toBe('Looks like: Node.js');
    expect((r.byTestId('name') as HTMLInputElement).value).toBe('api');

    r.byTestId('choice-own')!.click();
    const ttl = r.byTestId('ttl') as HTMLInputElement;
    ttl.value = '2h';
    ttl.dispatchEvent(new Event('input'));
    await r.settle();
    r.byTestId('deploy')!.click();
    await r.settle();
    const req = r.http.expectOne((q) => q.url.startsWith('/v1/previews'));
    expect(req.request.urlWithParams).toBe('/v1/previews?runtime=own&name=api&ttl=2h');
    const tar = await gunzipText(req.request.body);
    expect(tar).toContain('server.js');
    expect(tar).not.toContain('.DS_Store');
    req.flush({ title: 'x' }, { status: 500, statusText: 'x' });
    await r.settle();
  });

  it('a refused upload shows the detail and the compose violations', async () => {
    const r = await open();
    await r.fixture.componentInstance.accept(finish([{ path: 'Dockerfile', data: strToU8('FROM scratch') }]));
    await r.settle();
    expect(r.text('detected')).toContain('Own Dockerfile');
    r.byTestId('deploy')!.click();
    await r.settle();
    r.http.expectOne((q) => q.url.startsWith('/v1/previews')).flush(
      { title: 'unprocessable', detail: 'the compose file asks for things a preview may not have', violations: ['service "web": privileged is not allowed'], requestId: 'req-1' },
      { status: 422, statusText: 'Unprocessable' });
    await r.until(() => r.byTestId('error') !== null, 'error');
    expect(r.text('error')).toContain('may not have');
    expect(r.text('error')).toContain('req-1');
    expect(r.text('notes')).toContain('privileged is not allowed');
  });

  it('an empty drop is refused locally, with nothing sent', async () => {
    const r = await open();
    await r.fixture.componentInstance.accept(finish([{ path: '.DS_Store', data: strToU8('') }]));
    await r.settle();
    expect(r.text('error')).toContain('Nothing to upload');
    r.http.verify();
  });

  it('asks the server for a plan, shows its reasons, deploys with runtime=auto; a plan that cannot run blocks Deploy', async () => {
    const r = await open();
    await r.fixture.componentInstance.accept(finish([
      { path: 'site/package.json', data: strToU8('{"scripts":{"build":"vite build"}}') },
      { path: 'site/index.html', data: strToU8('<div id=app></div>') },
      { path: 'site/src/main.ts', data: strToU8('x') },
    ]));
    await r.settle();
    const ask = r.http.expectOne('/v1/runtimes/plan');
    // Paths all named; only the plan files' text sent.
    expect(ask.request.body).toEqual({ paths: ['index.html', 'package.json', 'src/main.ts'], files: { 'package.json': '{"scripts":{"build":"vite build"}}' }, runtime: 'auto' });
    expect(r.byTestId('planning')).not.toBeNull();
    ask.flush(contract.appPlan);
    await r.settle();
    const reasons = r.allByTestId('plan-reason').map((e) => e.textContent!.replace(/\s+/g, ' ').trim());
    expect(reasons.some((t) => t.includes('a build script and nothing to start') && t.endsWith('with nginx'))).toBe(true);
    expect(r.text('plan-summary')).toBe('node:24-alpine · npm install --no-audit --no-fund · npm run build · nginx serves the build output');
    expect((r.byTestId('deploy') as HTMLButtonElement).disabled).toBe(false);

    r.byTestId('deploy')!.click();
    await r.settle();
    const req = r.http.expectOne((q) => q.url.startsWith('/v1/previews'));
    expect(req.request.urlWithParams).toBe('/v1/previews?runtime=auto&name=site');
    req.flush({ title: 'x' }, { status: 500, statusText: 'x' });
    await r.settle();

    // Choosing a runtime plans again; an error there disables Deploy.
    r.byTestId('choice-bun')!.click();
    await r.settle();
    const again = r.http.expectOne('/v1/runtimes/plan');
    expect(again.request.body.runtime).toBe('bun');
    const refused: AppPlan = { ...(contract.appPlan as AppPlan), runtime: 'bun', reasons: [{ level: 'error', found: 'no entry file for TypeScript on Bun', then: 'the TypeScript on Bun runtime needs an entry file: one of index.ts' }], issues: [] };
    again.flush(refused);
    await r.settle();
    expect(r.allByTestId('plan-reason')[0]!.getAttribute('data-level')).toBe('error');
    expect((r.byTestId('deploy') as HTMLButtonElement).disabled).toBe(true);
    // "Looks like" is still what auto found.
    expect(r.text('detected')).toBe('Looks like: Node.js');
    r.http.verify();
  });

  it('add-ons: suggestions arrive ticked and ride the query; unticking everything sends none; a starter takes them too', async () => {
    const r = await open();
    await r.fixture.componentInstance.accept(finish([{ path: 'package.json', data: strToU8('{"dependencies":{"pg":"8"}}') }, { path: 'server.js', data: strToU8('x') }]));
    await r.settle();
    r.http.expectOne('/v1/runtimes/plan').flush({ ...(contract.appPlan as AppPlan), suggested: [{ id: 'postgres', because: 'pg' }] });
    await r.settle();
    expect((r.byTestId('addon-postgres') as HTMLInputElement).checked).toBe(true);
    expect((r.byTestId('addon-redis') as HTMLInputElement).checked).toBe(false);
    expect(r.text('suggested-postgres')).toBe('uses pg');

    r.byTestId('deploy')!.click();
    await r.settle();
    const first = r.http.expectOne((q) => q.url.startsWith('/v1/previews'));
    expect(first.request.urlWithParams).toBe('/v1/previews?runtime=auto&addons=postgres');
    first.flush({ title: 'x' }, { status: 500, statusText: 'x' });
    await r.settle();

    // Touching them re-plans with the choice, and an empty choice is said out loud.
    (r.byTestId('addon-postgres') as HTMLInputElement).click();
    await r.settle();
    expect(r.http.expectOne('/v1/runtimes/plan').request.body.addons).toEqual([]);
    r.byTestId('deploy')!.click();
    await r.settle();
    const second = r.http.expectOne((q) => q.url.startsWith('/v1/previews'));
    expect(second.request.urlWithParams).toBe('/v1/previews?runtime=auto&addons=none');
    second.flush({ title: 'x' }, { status: 500, statusText: 'x' });
    await r.settle();

    (r.byTestId('addon-redis') as HTMLInputElement).click();
    await r.settle();
    r.http.expectOne('/v1/runtimes/plan').flush(contract.appPlan);
    r.byTestId('starter-bun')!.click();
    await r.settle();
    expect(r.http.expectOne((q) => q.url.startsWith('/v1/previews')).request.urlWithParams).toBe('/v1/previews?runtime=bun&addons=redis');
  });
});
