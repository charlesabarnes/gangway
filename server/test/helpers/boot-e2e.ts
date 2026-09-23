import type { Running } from "../../src/boot.ts";
import { tempDir } from "./db.ts";
import { bootWithFakeDaemon, client } from "./fake-daemon.ts";
import { freePort } from "./free-port.ts";

export const API = "api.preview.localhost";
export const APP = "app.preview.localhost";
export const E2E_PASSWORD = "correct horse battery staple";
export const WHOAMI = { kind: "image", image: "traefik/whoami:v1.10", port: 80 } as const;

/** A real boot over the fake daemon in a fresh state directory, and its admin-token client. */
export async function bootE2e(env: Record<string, string> = {}, upstreamPort?: number) {
  const running = await bootWithFakeDaemon(
    tempDir(),
    upstreamPort ?? (await freePort()),
    undefined,
    env,
  );
  return { running, call: client(running) };
}

/** POST /v1/previews?wait=true as the admin token; whoami unless the body names a source. */
export function deployPreview(running: Running, body: Record<string, unknown>) {
  return client(running)(API, "/v1/previews?wait=true", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ visibility: "public", source: WHOAMI, ...body }),
  });
}

/** Fetch with no credential, on host:port as a browser would send it. */
export function browser(running: Running) {
  const port = running.listener.port;
  return (host: string, path: string, init: RequestInit = {}) =>
    fetch(`https://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { host: `${host}:${port}`, ...(init.headers as Record<string, string> | undefined) },
      tls: { rejectUnauthorized: false },
      redirect: "manual",
    } as RequestInit);
}

const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0]!;

/** Make the first admin through the setup link, as production does; returns its session cookie. */
export async function setupAdmin(running: Running) {
  const res = await browser(running)(APP, "/v1/auth/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: new URL(running.setupUrl!).searchParams.get("token"),
      email: "ada@example.com",
      password: E2E_PASSWORD,
    }),
  });
  return { status: res.status, session: cookieOf(res) };
}

/** Cut the viewer role down to previews.read, add a viewer, and sign them in. */
export async function signInPlainViewer(running: Running, adminSession: string) {
  const raw = browser(running);
  const headers = {
    cookie: adminSession,
    origin: `https://${APP}:${running.listener.port}`,
    "content-type": "application/json",
  };
  const roles = await raw(APP, "/v1/roles/viewer/permissions", {
    method: "PUT",
    headers,
    body: JSON.stringify({ permissions: ["previews.read"] }),
  });
  if (roles.status !== 200) throw new Error(`role edit answered ${roles.status}`);
  await raw(APP, "/v1/users", {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "vic@example.com", password: E2E_PASSWORD, roleId: "viewer" }),
  });
  const login = await raw(APP, "/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "vic@example.com", password: E2E_PASSWORD }),
  });
  return cookieOf(login);
}

export { cookieOf };
