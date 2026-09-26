import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const HERE = import.meta.dir;
const OUT = path.join(HERE, "dist");
const FONTS: Record<string, string> = {
  "sans-400": "ibm-plex-sans-condensed/files/ibm-plex-sans-condensed-latin-400-normal.woff2",
  "sans-500": "ibm-plex-sans-condensed/files/ibm-plex-sans-condensed-latin-500-normal.woff2",
  "sans-600": "ibm-plex-sans-condensed/files/ibm-plex-sans-condensed-latin-600-normal.woff2",
  "serif-400": "ibm-plex-serif/files/ibm-plex-serif-latin-400-normal.woff2",
  "serif-400-italic": "ibm-plex-serif/files/ibm-plex-serif-latin-400-italic.woff2",
  "serif-500-italic": "ibm-plex-serif/files/ibm-plex-serif-latin-500-italic.woff2",
  "mono-400": "ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2",
  "mono-600": "ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2",
  "inter-400": "inter/files/inter-latin-400-normal.woff2",
  "inter-500": "inter/files/inter-latin-500-normal.woff2",
  "inter-600": "inter/files/inter-latin-600-normal.woff2",
  "inter-700": "inter/files/inter-latin-700-normal.woff2",
  "hand-400": "kalam/files/kalam-latin-400-normal.woff2",
  "hand-700": "kalam/files/kalam-latin-700-normal.woff2",
};

await rm(OUT, { recursive: true, force: true });
await mkdir(path.join(OUT, "fonts"), { recursive: true });
const built = await Bun.build({
  entrypoints: [path.join(HERE, "src/main.ts")],
  outdir: OUT,
  naming: "kit.js",
  target: "browser",
  format: "esm",
  minify: true,
  sourcemap: "none",
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}
await Bun.write(path.join(OUT, "kit.css"), Bun.file(path.join(HERE, "src/kit.css")));
for (const [name, rel] of Object.entries(FONTS)) {
  const src = Bun.resolveSync(`@fontsource/${rel}`, HERE);
  await Bun.write(path.join(OUT, "fonts", `${name}.woff2`), Bun.file(src));
}
for (const name of ["logo.svg", "logo-light.svg"])
  await Bun.write(path.join(OUT, name), Bun.file(path.join(HERE, "../web/public", name)));
await Bun.write(
  path.join(OUT, "favicon.svg"),
  Bun.file(path.join(HERE, "../web/public/favicon-preview.svg")),
);
const js = await Bun.file(path.join(OUT, "kit.js")).arrayBuffer();
const css = await Bun.file(path.join(OUT, "kit.css")).arrayBuffer();
const hasher = new Bun.CryptoHasher("sha256");
hasher.update(js);
hasher.update(css);
const version = hasher.digest("hex").slice(0, 12);
await Bun.write(path.join(OUT, "manifest.json"), `${JSON.stringify({ version }, null, 2)}\n`);
console.log(`render/dist: kit.js ${(js.byteLength / 1024).toFixed(0)} KiB, version ${version}`);
