import { DeferBlockBehavior, TestBed } from '@angular/core/testing';
import { strToU8 } from 'fflate';
import contract from '../../../testing/fixtures/contract.json';
import { render } from '../../../testing/render';
import type { Permission, PreviewSourceFiles } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { finish } from '../new/pack';
import { SourcePanel } from './source-panel';

const ID = '01SOURCE000000000000000000';
const SRC: PreviewSourceFiles = {
  runtime: 'bun',
  truncated: false,
  files: [
    { path: 'index.ts', size: 30, text: 'export default { fetch() {} };\n' },
    { path: 'lib/util.ts', size: 12, text: 'export {};\n' },
    { path: 'logo.png', size: 20_480 },
  ],
};

async function open(
  o: { uploaded?: boolean; permissions?: Permission[]; source?: PreviewSourceFiles | 404 } = {},
) {
  // The CodeMirror chunk is not what these specs are about: keep the @defer block closed.
  TestBed.configureTestingModule({ deferBlockBehavior: DeferBlockBehavior.Manual });
  const r = await render(SourcePanel, { inputs: { previewId: ID, uploaded: o.uploaded ?? true } });
  const loading = TestBed.inject(AuthService).refresh();
  r.http.expectOne('/v1/auth/session').flush({
    authenticated: true,
    setupRequired: false,
    permissions: o.permissions ?? ['previews.read', 'previews.update'],
  });
  await loading;
  await r.settle();
  if (o.uploaded !== false) {
    const req = r.http.expectOne(`/v1/previews/${ID}/source`);
    if (o.source === 404)
      req.flush(
        { title: 'not found', detail: 'nothing kept' },
        { status: 404, statusText: 'Not Found' },
      );
    else req.flush(o.source ?? SRC);
    await r.settle();
  }
  return r;
}

describe('SourcePanel', () => {
  it('is never asked for on a preview that was not uploaded', async () => {
    const r = await open({ uploaded: false });
    expect(r.byTestId('source')).toBeNull();
    r.http.verify();
  });

  it('hides quietly when nothing is kept (404)', async () => {
    const r = await open({ source: 404 });
    expect(r.byTestId('source')).toBeNull();
    expect(r.byTestId('source-error')).toBeNull();
    r.http.verify();
  });

  it('lists the files; binary ones are read-only; the first text file is selected', async () => {
    const r = await open();
    r.http.expectOne('/v1/runtimes').flush(contract.runtimeList);
    await r.settle();
    const files = r.allByTestId('file');
    expect(files.map((f) => f.dataset['path'])).toEqual(['index.ts', 'lib/util.ts', 'logo.png']);
    expect((files[2] as HTMLButtonElement).disabled).toBe(true);
    expect(r.text('selected')).toBe('index.ts');
    expect(r.text('runtime')).toBe('TypeScript on Bun');
    expect((r.byTestId('save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a save sends ONLY what changed: edits as text, new files, deletions as null', async () => {
    const r = await open();
    r.http.expectOne('/v1/runtimes').flush(contract.runtimeList);
    const draft = r.fixture.componentInstance.draft;
    draft.edit('index.ts', 'export default { fetch() { return new Response("2"); } };\n');
    draft.edit('lib/util.ts', 'export {};\n'); // the same text: not a change
    draft.add('src/new.ts');
    draft.edit('src/new.ts', 'export const x = 1;\n');
    draft.remove('lib/util.ts');
    await r.settle();
    expect(r.allByTestId('file').map((f) => f.dataset['path'])).toEqual([
      'index.ts',
      'logo.png',
      'src/new.ts',
    ]);

    r.byTestId('save')!.click();
    await r.settle();
    const req = r.http.expectOne(`/v1/previews/${ID}/source`);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({
      files: {
        'index.ts': 'export default { fetch() { return new Response("2"); } };\n',
        'src/new.ts': 'export const x = 1;\n',
        'lib/util.ts': null,
      },
    });
    req.flush(contract.redeployAccepted, { status: 202, statusText: 'Accepted' });
    await r.settle();
    // Saved is the new baseline: nothing left to save, and the rebuild is under way.
    expect((r.byTestId('save') as HTMLButtonElement).disabled).toBe(true);
    expect(r.text('redeploy-status')).toContain('Rebuilding');
    expect(draft.changes()).toEqual({});
    r.http.verify();
  });

  it('refuses a new file under .gangway/, locally', async () => {
    const r = await open();
    r.http.expectOne('/v1/runtimes').flush(contract.runtimeList);
    const path = r.byTestId('new-path') as HTMLInputElement;
    path.value = '.gangway/Dockerfile';
    path.dispatchEvent(new Event('input'));
    path.closest('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await r.settle();
    expect(r.text('source-error')).toContain('.gangway/');
    r.http.verify();
  });

  it('a refused save shows why and keeps the edits', async () => {
    const r = await open();
    r.http.expectOne('/v1/runtimes').flush(contract.runtimeList);
    r.fixture.componentInstance.draft.edit('index.ts', 'broken');
    await r.settle();
    r.byTestId('save')!.click();
    await r.settle();
    r.http
      .expectOne(`/v1/previews/${ID}/source`)
      .flush(
        { title: 'unprocessable', detail: 'the new source exposes different services' },
        { status: 422, statusText: 'x' },
      );
    await r.until(() => r.byTestId('source-error') !== null, 'error');
    expect(r.text('source-error')).toContain('different services');
    expect(r.fixture.componentInstance.draft.changes()).toEqual({ 'index.ts': 'broken' });
  });

  it('replacing files PUTs a gzipped tar with the current runtime, then reloads the source', async () => {
    const r = await open();
    r.http.expectOne('/v1/runtimes').flush(contract.runtimeList);
    const done = r.fixture.componentInstance.replace(
      finish([{ path: 'site/index.html', data: strToU8('<p>new</p>') }]),
    );
    await r.settle();
    const put = r.http.expectOne(
      (q) => q.url.startsWith(`/v1/previews/${ID}/source`) && q.method === 'PUT',
    );
    expect(put.request.urlWithParams).toBe(`/v1/previews/${ID}/source?runtime=bun`);
    expect(put.request.headers.get('content-type')).toBe('application/gzip');
    put.flush(contract.redeployAccepted, { status: 202, statusText: 'Accepted' });
    await r.settle();
    r.http.expectOne(`/v1/previews/${ID}/source`).flush({
      runtime: 'bun',
      truncated: false,
      files: [{ path: 'index.html', size: 10, text: '<p>new</p>' }],
    });
    await done;
    await r.settle();
    expect(r.allByTestId('file').map((f) => f.dataset['path'])).toEqual(['index.html']);
  });

  it('without previews.update: the source is shown, but nothing can be saved or replaced', async () => {
    const r = await open({ permissions: ['previews.read'] });
    expect(r.byTestId('source')).not.toBeNull();
    expect(r.byTestId('save')).toBeNull();
    expect(r.byTestId('replace')).toBeNull();
    expect(r.byTestId('new-path')).toBeNull();
    r.http.verify(); // and no runtime list is fetched for a picker it cannot use
  });
});
