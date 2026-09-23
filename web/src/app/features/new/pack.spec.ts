import { gunzipSync, strToU8, zipSync } from 'fflate';
import contract from '../../../testing/fixtures/contract.json';
import type { DetectionRule } from '../../core/api.types';
import {
  collectFromFiles,
  detect,
  finish,
  isJunk,
  normalizePath,
  packStarter,
  stripCommonRoot,
  unzip,
  UploadError,
  writeTar,
  type UploadFile,
} from './pack';

const dec = new TextDecoder();
const file = (path: string, text = path): UploadFile => ({ path, data: strToU8(text) });

/** A minimal ustar reader, written from the spec rather than from the writer. */
function readTar(
  tar: Uint8Array,
): { path: string; type: string; size: number; mode: number; text: string }[] {
  const out = [];
  for (let at = 0; at + 512 <= tar.length;) {
    const h = tar.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const str = (o: number, n: number) => dec.decode(h.subarray(o, o + n)).replace(/\0.*$/s, '');
    const size = parseInt(str(124, 12), 8);
    // The checksum: every header byte, with its own field read as spaces.
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    expect(parseInt(str(148, 8), 8)).toBe(sum);
    expect(str(257, 6)).toBe('ustar');
    const prefix = str(345, 155);
    const name = str(0, 100);
    const path = prefix ? `${prefix}/${name}` : name;
    out.push({
      path,
      type: str(156, 1),
      size,
      mode: parseInt(str(100, 8), 8),
      text: dec.decode(tar.subarray(at + 512, at + 512 + size)),
    });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** The server's real rules, as `GET /v1/runtimes` sends them (shared/src/runtimes.ts DETECTION). */
const RULES: DetectionRule[] = [
  {
    runtime: 'own',
    markers: [
      'compose.yaml',
      'compose.yml',
      'docker-compose.yaml',
      'docker-compose.yml',
      'Dockerfile',
    ],
  },
  { runtime: 'workerd', markers: ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'] },
  { runtime: 'deno', markers: ['deno.json', 'deno.jsonc'] },
  { runtime: 'bun', markers: ['bun.lock', 'bun.lockb', 'bunfig.toml'] },
  { runtime: 'node', markers: ['package.json'] },
  { runtime: 'python', markers: ['requirements.txt', 'main.py', 'app.py'] },
  { runtime: 'php', markers: ['index.php'] },
  { runtime: 'bun', markers: ['index.ts', 'main.ts', 'worker.ts', 'src/index.ts'] },
];

describe('packing an upload', () => {
  it('writes a ustar archive a reader parses back: regular files only, checksums right', () => {
    const tar = writeTar(
      [file('index.html', '<h1>hi</h1>'), file('assets/app.js', 'x'.repeat(700))],
      1_700_000_000,
    );
    expect(tar.length % 512).toBe(0);
    const entries = readTar(tar);
    expect(entries.map((e) => [e.path, e.type])).toEqual([
      ['index.html', '0'],
      ['assets/app.js', '0'],
    ]);
    expect(entries[0]!.text).toBe('<h1>hi</h1>');
    expect(entries[1]!.size).toBe(700);
    expect(entries[1]!.text).toBe('x'.repeat(700));
    expect(entries[0]!.mode).toBe(0o644);
  });

  it('puts a long path in the ustar prefix field, and refuses one that cannot fit', () => {
    const long = `${'a'.repeat(120)}/${'b'.repeat(60)}.txt`;
    expect(readTar(writeTar([file(long)])).at(-1)!.path).toBe(long);
    expect(() => writeTar([file('x'.repeat(130))])).toThrow(UploadError);
  });

  it('a starter becomes a gzipped tar of exactly its files', () => {
    const blob = packStarter({
      'src/index.ts': 'export default {};\n',
      'wrangler.toml': 'main = "src/index.ts"\n',
    });
    expect(blob.type).toBe('application/gzip');
    return blob.arrayBuffer().then((buf) => {
      const entries = readTar(gunzipSync(new Uint8Array(buf))).filter((e) => e.type === '0');
      expect(entries.map((e) => e.path).sort()).toEqual(['src/index.ts', 'wrangler.toml']);
      expect(entries.find((e) => e.path === 'src/index.ts')!.text).toBe('export default {};\n');
    });
  });

  it('skips OS litter, VCS and dependencies', () => {
    for (const p of [
      '__MACOSX/x',
      '.git/config',
      'a/node_modules/b.js',
      '.DS_Store',
      'd/Thumbs.db',
      'img/._photo.png',
    ])
      expect(isJunk(p)).toBe(true);
    for (const p of ['index.html', 'src/git.ts', 'modules/x.js', '.env.example'])
      expect(isJunk(p)).toBe(false);
  });

  it('normalises paths and refuses ones that climb out', () => {
    expect(normalizePath('./a//b\\c.txt')).toBe('a/b/c.txt');
    expect(() => normalizePath('../etc/passwd')).toThrow(UploadError);
    expect(() => normalizePath('a/../../b')).toThrow(UploadError);
  });

  it('strips ONE common root folder and remembers it as the name', () => {
    expect(stripCommonRoot([file('site/index.html'), file('site/css/a.css')])).toEqual({
      root: 'site',
      files: [file('index.html', 'site/index.html'), file('css/a.css', 'site/css/a.css')],
    });
    expect(stripCommonRoot([file('site/index.html'), file('README.md')]).root).toBeNull();
    expect(stripCommonRoot([file('index.html')]).root).toBeNull();
  });

  it('finish(): junk counted, root stripped, sorted, duplicates refused', () => {
    const c = finish([
      file('app/package.json'),
      file('app/node_modules/x/index.js'),
      file('app/.DS_Store'),
      file('app/server.js'),
    ]);
    expect(c.files.map((f) => f.path)).toEqual(['package.json', 'server.js']);
    expect(c.skipped).toBe(2);
    expect(c.name).toBe('app');
    expect(() => finish([file('a.txt'), file('./a.txt')])).toThrow(/twice/);
  });

  it('a zip is expanded in the browser, directories dropped', async () => {
    const zip = zipSync({
      'site/': new Uint8Array(0),
      'site/index.html': strToU8('<p>zip</p>'),
      'site/a/b.css': strToU8('b{}'),
    });
    expect(
      unzip(zip)
        .map((f) => f.path)
        .sort(),
    ).toEqual(['site/a/b.css', 'site/index.html']);
    expect(() => unzip(strToU8('not a zip'))).toThrow(UploadError);

    const c = await collectFromFiles([new File([zip as Uint8Array<ArrayBuffer>], 'my-site.zip')]);
    expect(c.files.map((f) => f.path)).toEqual(['a/b.css', 'index.html']);
    expect(c.name).toBe('site');
    const flat = await collectFromFiles([
      new File([zipSync({ 'index.php': strToU8('<?php') }) as Uint8Array<ArrayBuffer>], 'blog.zip'),
    ]);
    expect(flat.name).toBe('blog');
  });

  it('a folder picked with webkitdirectory keeps its relative paths', async () => {
    const f = new File(['{}'], 'package.json');
    Object.defineProperty(f, 'webkitRelativePath', { value: 'api/package.json' });
    const c = await collectFromFiles([f]);
    expect(c.files[0]!.path).toBe('package.json');
    expect(c.name).toBe('api');
  });

  it('detect() follows the server rules in order, and anything else is static', () => {
    expect(detect(['Dockerfile', 'package.json'], RULES)).toBe('own');
    expect(detect(['wrangler.toml', 'package.json', 'src/index.ts'], RULES)).toBe('workerd');
    expect(detect(['bun.lock', 'package.json'], RULES)).toBe('bun');
    expect(detect(['package.json', 'index.ts'], RULES)).toBe('node');
    expect(detect(['main.py'], RULES)).toBe('python');
    expect(detect(['index.php', 'style.css'], RULES)).toBe('php');
    expect(detect(['index.ts'], RULES)).toBe('bun');
    expect(detect(['index.html', 'app.js'], RULES)).toBe('static');
    // The contract's example is the same shape.
    expect(detect(['compose.yaml'], contract.runtimeList.detection as DetectionRule[])).toBe('own');
  });
});
