/**
 * Import layering, as promised by ADR-0003 and docs/STATUS.md:
 *   - nothing below app/ may import app/  (the service layer has no HTTP types)
 *   - only db/sqlite.ts may import bun:sqlite
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../../src");
const IMPORT = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

function* sources(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (e.name.endsWith(".ts")) yield p;
  }
}

const files = [...sources(SRC)].map((path) => ({
  rel: relative(SRC, path),
  imports: [...readFileSync(path, "utf8").matchAll(IMPORT)].map((m) => ({
    spec: m[1]!,
    target: m[1]!.startsWith(".") ? relative(SRC, resolve(dirname(path), m[1]!)) : m[1]!,
  })),
}));

test("the scan actually sees the tree", () => {
  expect(files.length).toBeGreaterThan(40);
  expect(files.some((f) => f.rel === "app/app.ts" && f.imports.length > 3)).toBe(true);
});

test("nothing below app/ imports app/", () => {
  const offenders = files
    .filter((f) => !f.rel.startsWith("app/") && f.rel !== "main.ts" && f.rel !== "boot.ts")
    .flatMap((f) => f.imports.filter((i) => i.target.startsWith("app/")).map((i) => `${f.rel} -> ${i.spec}`));
  expect(offenders).toEqual([]);
});

test("only db/sqlite.ts imports bun:sqlite", () => {
  const offenders = files.filter((f) => f.rel !== "db/sqlite.ts" && f.imports.some((i) => i.spec === "bun:sqlite")).map((f) => f.rel);
  expect(offenders).toEqual([]);
});
