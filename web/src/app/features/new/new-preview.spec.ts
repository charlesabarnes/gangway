import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { gunzipSync, strToU8 } from 'fflate';
import contract from '../../../testing/fixtures/contract.json';
import { render } from '../../../testing/render';
import type { Permission, Preview, RuntimeList } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { NewPreview } from './new-preview';
import { finish } from './pack';

@Component({ template: '' })
class Blank {}

const RUNTIMES: RuntimeList = {
  runtimes: [
    { id: 'static', name: 'Static site', language: 'HTML', description: 'nginx', image: 'nginx', port: 8080, starter: { 'index.html': '<h1>hi</h1>' } },
    { id: 'bun', name: 'TypeScript on Bun', language: 'TypeScript', description: 'bun', image: 'oven/bun', port: 3000, starter: { 'index.ts': 'export default {};' } },
    { id: 'node', name: 'Node.js', language: 'JavaScript', description: 'node', image: 'node', port: 3000, starter: { 'server.js': '' } },
  ],
  detection: [{ runtime: 'own', markers: ['Dockerfile'] }, { runtime: 'node', markers: ['package.json'] }, { runtime: 'bun', markers: ['index.ts'] }],
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
    r.byTestId('starter-bun')!.click();
    await r.settle();

    const req = r.http.expectOne((q) => q.url.startsWith('/v1/previews'));
    expect(req.request.method).toBe('POST');
    expect(req.request.urlWithParams).toBe('/v1/previews?runtime=bun');
    expect(req.request.headers.get('content-type')).toBe('application/gzip');
    expect(await gunzipText(req.request.body)).toContain('export default {};');
    req.flush({ preview: { ...(contract.preview as Preview), id: '01NEWPREVIEW0000000000000A' } }, { status: 202, statusText: 'Accepted' });
    await r.until(() => navigate.mock.calls.length > 0, 'navigation');
    expect(navigate).toHaveBeenCalledWith(['/previews', '01NEWPREVIEW0000000000000A']);
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

    const select = r.byTestId('runtime-select') as HTMLSelectElement;
    select.value = 'own';
    select.dispatchEvent(new Event('change'));
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
});
