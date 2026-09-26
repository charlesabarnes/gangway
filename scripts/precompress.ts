import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { compress, compressible } from "../server/src/net/encode.ts";

// Writes .br and .gz beside every compressible file under the given dirs, for the server to send.

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && !/\.(br|gz)$/.test(e.name)) yield p;
  }
}

let n = 0;
for (const dir of process.argv.slice(2)) {
  for await (const file of walk(dir)) {
    const { size } = await stat(file);
    if (!compressible(Bun.file(file).type, size)) continue;
    const data = await Bun.file(file).bytes();
    const [br, gz] = await Promise.all([compress(data, "br"), compress(data, "gzip")]);
    await Promise.all([writeFile(`${file}.br`, br), writeFile(`${file}.gz`, gz)]);
    n++;
  }
}
console.log(`precompressed ${n} files`);
