import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

export type Encoding = "br" | "gzip";

const COMPRESSIBLE =
  /^(text\/|application\/(javascript|json|xml|manifest\+json|wasm)|image\/svg\+xml)/;
const MIN = 1024;
const MAX = 8 * 1024 * 1024;
const CACHE_BYTES = 64 * 1024 * 1024;

// Bundler output names (main-NI5PORVS.js, chunk-D-pZzVZ32.js), not apple-touch-icon.png.
export const HASHED =
  /-(?=[\w-]{8,16}\.)(?=[^.]*[A-Z0-9])[\w-]{8,16}\.(?:js|css|woff2?|png|svg|jpg|webp|ico|map)$/;

export const siblingSidecar = (abs: string, enc: Encoding) =>
  `${abs}.${enc === "br" ? "br" : "gz"}`;

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

export function negotiate(acceptEncoding: string | null): Encoding | null {
  const offered = new Map<string, number>();
  for (const part of (acceptEncoding ?? "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name) {
      continue;
    }
    const q = params.map((p) => /^\s*q=([\d.]+)/.exec(p)?.[1]).find((v) => v !== undefined);
    offered.set(name, q === undefined ? 1 : Number(q));
  }
  const takes = (e: string) => (offered.get(e) ?? offered.get("*") ?? 0) > 0;
  if (takes("br")) {
    return "br";
  }
  if (takes("gzip")) {
    return "gzip";
  }
  return null;
}

export function compressible(type: string, size: number): boolean {
  return COMPRESSIBLE.test(type) && size >= MIN && size <= MAX;
}

export function compress(data: Uint8Array, enc: Encoding, fast = false): Promise<Uint8Array> {
  return enc === "br"
    ? brotli(data, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: fast ? 5 : 11,
          [constants.BROTLI_PARAM_SIZE_HINT]: data.byteLength,
        },
      })
    : gz(data, { level: fast ? 6 : 9 });
}

type Entry = { key: string; body: Uint8Array };

// A miss compresses in the background and answers null, so no request waits on a compressor.
export class EncodedCache {
  readonly #entries = new Map<string, Entry>();
  readonly #pending = new Set<string>();
  #bytes = 0;

  readonly budget: number;

  constructor(budget = CACHE_BYTES) {
    this.budget = budget;
  }

  get(abs: string, size: number, mtime: number, enc: Encoding): Uint8Array | null {
    const id = `${enc}:${abs}`;
    const key = `${size}:${mtime}`;
    const hit = this.#entries.get(id);
    if (hit && hit.key === key) {
      this.#entries.delete(id);
      this.#entries.set(id, hit);
      return hit.body;
    }
    if (!this.#pending.has(id)) {
      this.#pending.add(id);
      void this.#fill(id, key, abs, enc).finally(() => this.#pending.delete(id));
    }
    return null;
  }

  async settled(): Promise<void> {
    while (this.#pending.size > 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  async #fill(id: string, key: string, abs: string, enc: Encoding): Promise<void> {
    try {
      const body = await compress(await Bun.file(abs).bytes(), enc, true);
      const old = this.#entries.get(id);
      if (old) {
        this.#bytes -= old.body.byteLength;
      }
      this.#entries.delete(id);
      this.#entries.set(id, { key, body });
      this.#bytes += body.byteLength;
      for (const [k, e] of this.#entries) {
        if (this.#bytes <= this.budget) {
          break;
        }
        this.#entries.delete(k);
        this.#bytes -= e.body.byteLength;
      }
    } catch {
      // A file that vanished or would not compress is sent as it is.
    }
  }
}

export const sharedEncodedCache = new EncodedCache();

export type Encoded = { body: Blob | Uint8Array; encoding: Encoding | null };

/** A precompressed copy no older than the file, else the cache's, else the file itself. */
export async function encodedFile(
  req: Request,
  abs: string,
  f: { size: number; mtime: number; type: string },
  o: { sidecar?: ((abs: string, enc: Encoding) => string) | undefined; cache?: EncodedCache } = {},
): Promise<Encoded> {
  const enc = negotiate(req.headers.get("accept-encoding"));
  if (!enc || !compressible(f.type, f.size)) {
    return { body: Bun.file(abs), encoding: null };
  }
  const tried: Encoding[] = enc === "br" ? ["br", "gzip"] : ["gzip"];
  if (o.sidecar) {
    for (const e of tried) {
      const p = o.sidecar(abs, e);
      const st = await stat(p).catch(() => null);
      if (st?.isFile() && st.mtimeMs >= f.mtime) {
        return { body: Bun.file(p), encoding: e };
      }
    }
  }
  const cached = (o.cache ?? sharedEncodedCache).get(abs, f.size, f.mtime, enc);
  return cached ? { body: cached, encoding: enc } : { body: Bun.file(abs), encoding: null };
}

/** Whether a request's validators match: If-None-Match (weakly, lists, *), else If-Modified-Since. */
export function notModified(req: Request, etag: string, mtime?: number): boolean {
  const inm = req.headers.get("if-none-match");
  if (inm !== null) {
    const bare = (t: string) => t.trim().replace(/^W\//, "");
    const want = bare(etag);
    return inm.split(",").some((t) => t.trim() === "*" || bare(t) === want);
  }
  const ims = req.headers.get("if-modified-since");
  if (ims === null || mtime === undefined) {
    return false;
  }
  const since = Date.parse(ims);
  return !Number.isNaN(since) && Math.floor(mtime / 1000) * 1000 <= since;
}

/** A single `bytes=` range within `size`, or null for none, several, or one out of bounds. */
export function singleRange(
  header: string | null,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) {
    return null;
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) {
    return null;
  }
  let start: number;
  let end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) {
      return "unsatisfiable";
    }
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) {
    return "unsatisfiable";
  }
  return { start, end };
}
