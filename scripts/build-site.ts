// Copies site/ to dist/site with a content hash on every local CSS and JS link, because Pages lets
// browsers cache for ten minutes and a visitor could otherwise get new HTML with old CSS and JS.
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SRC = path.join(ROOT, "site");
const OUT = path.resolve(ROOT, process.argv[2] ?? "dist/site");
const ASSET = /\b(href|src)="((?:css|js)\/[^"?#]+)"/g;

const hashes = new Map<string, string>();
function hashOf(file: string): string {
  let h = hashes.get(file);
  if (!h) {
    h = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 10);
    hashes.set(file, h);
  }
  return h;
}

rmSync(OUT, { recursive: true, force: true });
cpSync(SRC, OUT, { recursive: true });

let tagged = 0;
for (const name of readdirSync(OUT, { recursive: true, encoding: "utf8" })) {
  if (!name.endsWith(".html")) continue;
  const page = path.join(OUT, name);
  const html = readFileSync(page, "utf8").replace(ASSET, (_, attr: string, ref: string) => {
    const file = path.join(path.dirname(page), ref);
    if (!existsSync(file)) throw new Error(`${name}: ${attr}="${ref}" points at a missing file`);
    tagged++;
    return `${attr}="${ref}?v=${hashOf(file)}"`;
  });
  writeFileSync(page, html);
}
console.log(`site built into ${path.relative(ROOT, OUT)}: ${tagged} links tagged`);
