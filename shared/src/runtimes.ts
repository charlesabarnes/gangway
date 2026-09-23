export const RUNTIME_IDS = ["static", "node", "bun", "deno", "workerd", "python", "php"] as const;
export type RuntimeId = (typeof RUNTIME_IDS)[number];
export type Runtime = {
  id: RuntimeId;
  name: string;
  language: string;
  description: string;
  image: string;
  // The default is the entry matching `image`, not the first key: JS orders integer-like keys numerically.
  versions: Readonly<Record<string, string>>;
  port: number;
  entries: readonly string[];
  starter: Readonly<Record<string, string>>;
};

const WORKER_TS = `/**
 * A Workers-style handler: every request to the preview comes through fetch().
 * Save to rebuild the preview at the same URL.
 */
export default {
  async fetch(request: Request, env: Record<string, string>): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/time") {
      return Response.json({ now: new Date().toISOString() });
    }
    return new Response(\`Hello from __RUNTIME__! You asked for \${url.pathname}\\n\`, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
`;

const worker = (name: string) => WORKER_TS.replace("__RUNTIME__", name);

export const RUNTIMES: readonly Runtime[] = [
  {
    id: "static",
    name: "Static site",
    language: "HTML",
    description:
      "Files served as they are by nginx. A root index.html becomes the fallback for unknown paths (single-page apps) unless there is a 404.html; with neither, directories are listed.",
    image: "nginxinc/nginx-unprivileged:1.29-alpine",
    versions: { "1.29": "nginxinc/nginx-unprivileged:1.29-alpine" },
    port: 8080,
    entries: [],
    starter: {
      "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hello</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <main>
      <h1>Hello from gangway</h1>
      <p>Edit these files and save to rebuild this preview at the same URL.</p>
    </main>
  </body>
</html>
`,
      "style.css": `body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; }
main { max-width: 40rem; padding: 2rem; }
`,
    },
  },
  {
    id: "node",
    name: "Node.js",
    language: "JavaScript",
    description:
      "npm (or pnpm/yarn by lockfile) installs, `npm run build` if there is one, then `npm start` -- or `node` on package.json's main. Listen on $PORT.",
    image: "node:24-alpine",
    versions: { "24": "node:24-alpine", "22": "node:22-alpine", "20": "node:20-alpine" },
    port: 3000,
    entries: ["server.js", "index.js", "app.js", "main.js"],
    starter: {
      "package.json": `{
  "name": "hello",
  "private": true,
  "type": "module",
  "scripts": { "start": "node server.js" }
}
`,
      "server.js": `import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3000);
createServer((req, res) => {
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(\`Hello from Node.js! You asked for \${req.url}\\n\`);
}).listen(port, "0.0.0.0", () => console.log(\`listening on :\${port}\`));
`,
    },
  },
  {
    id: "bun",
    name: "TypeScript on Bun",
    language: "TypeScript",
    description:
      "Runs the entry file as-is -- no build step. Export a Workers-style `{ fetch }` (or a function), or serve on $PORT yourself. A package.json is installed with `bun install`.",
    image: "oven/bun:1.4.2-alpine",
    versions: { "1.4": "oven/bun:1.4.2-alpine" },
    port: 3000,
    entries: [
      "index.ts",
      "index.tsx",
      "index.js",
      "main.ts",
      "main.js",
      "worker.ts",
      "worker.js",
      "server.ts",
      "src/index.ts",
      "src/index.js",
      "src/main.ts",
      "src/worker.ts",
    ],
    starter: { "index.ts": worker("Bun") },
  },
  {
    id: "deno",
    name: "TypeScript on Deno",
    language: "TypeScript",
    description:
      "Runs the entry file as-is, dependencies cached at build. Export a Workers-style `{ fetch }` (or a function), or serve on $PORT yourself. Runs with -A: the container is the sandbox.",
    image: "denoland/deno:alpine-2.9.7",
    versions: { "2.9": "denoland/deno:alpine-2.9.7" },
    port: 8000,
    entries: [
      "main.ts",
      "main.tsx",
      "main.js",
      "index.ts",
      "index.js",
      "worker.ts",
      "server.ts",
      "mod.ts",
      "src/main.ts",
      "src/index.ts",
    ],
    starter: { "main.ts": worker("Deno") },
  },
  {
    id: "workerd",
    name: "Cloudflare Worker (workerd)",
    language: "TypeScript",
    description:
      "Cloudflare's own Workers runtime. The entry (wrangler's `main`, else index.ts) is bundled with esbuild; `.wasm` imports become WebAssembly modules; secrets arrive on `env`. nodejs_compat is on.",
    image: "node:24-bookworm-slim + workerd 1.20260922.1",
    versions: { "1.20260922": "node:24-bookworm-slim" },
    port: 8080,
    entries: [
      "src/index.ts",
      "src/index.js",
      "src/worker.ts",
      "index.ts",
      "index.js",
      "worker.ts",
      "worker.js",
    ],
    starter: {
      "src/index.ts": worker("workerd"),
      "wrangler.toml": `name = "hello"
main = "src/index.ts"
compatibility_date = "2026-09-01"
`,
    },
  },
  {
    id: "python",
    name: "Python",
    language: "Python",
    description:
      "`pip install -r requirements.txt` if there is one, then `python` on the entry file. Listen on $PORT, on 0.0.0.0.",
    image: "python:3.14-slim",
    versions: {
      "3.14": "python:3.14-slim",
      "3.13": "python:3.13-slim",
      "3.12": "python:3.12-slim",
    },
    port: 8000,
    entries: ["main.py", "app.py", "server.py"],
    starter: {
      "main.py": `import os
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = f"Hello from Python! You asked for {self.path}\\n".encode()
        self.send_response(200)
        self.send_header("content-type", "text/plain; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


port = int(os.environ.get("PORT", "8000"))
print(f"listening on :{port}", flush=True)
HTTPServer(("0.0.0.0", port), Handler).serve_forever()
`,
    },
  },
  {
    id: "php",
    name: "PHP",
    language: "PHP",
    description: "Apache with mod_php serving the files; .php runs, everything else is static.",
    image: "php:8.5-apache",
    versions: { "8.5": "php:8.5-apache", "8.4": "php:8.4-apache", "8.3": "php:8.3-apache" },
    port: 80,
    entries: [],
    starter: {
      "index.php": `<?php
header('content-type: text/plain; charset=utf-8');
echo "Hello from PHP " . PHP_VERSION . "! You asked for " . $_SERVER['REQUEST_URI'] . "\\n";
`,
    },
  },
];

export const runtimeById = (id: RuntimeId): Runtime => RUNTIMES.find((r) => r.id === id)!;

export type Detected = RuntimeId | "own";

export const DETECTION: readonly { runtime: Detected; markers: readonly string[] }[] = [
  {
    runtime: "own",
    markers: [
      "compose.yaml",
      "compose.yml",
      "docker-compose.yaml",
      "docker-compose.yml",
      "Dockerfile",
    ],
  },
  // Before node: Laravel and Symfony carry a package.json for their front-end assets.
  { runtime: "php", markers: ["composer.json"] },
  { runtime: "workerd", markers: ["wrangler.toml", "wrangler.json", "wrangler.jsonc"] },
  { runtime: "deno", markers: ["deno.json", "deno.jsonc"] },
  { runtime: "bun", markers: ["bun.lock", "bun.lockb", "bunfig.toml"] },
  { runtime: "node", markers: ["package.json"] },
  { runtime: "python", markers: ["requirements.txt", "main.py", "app.py"] },
  { runtime: "php", markers: ["index.php"] },
  { runtime: "bun", markers: ["index.ts", "main.ts", "worker.ts", "src/index.ts"] },
];

export function detectRuntime(paths: Iterable<string>): Detected {
  const have = new Set(paths);
  for (const rule of DETECTION) if (rule.markers.some((m) => have.has(m))) return rule.runtime;
  return "static";
}
