import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { DefaultPasswordMode } from "@gangway/shared/domain";
import type { AppEnv } from "../../src/app/env.ts";
import { errorHandler } from "../../src/app/problem.ts";
import { previewRoutes } from "../../src/app/routes/previews.ts";
import { settingsRoutes } from "../../src/app/routes/settings.ts";
import type { Actor } from "../../src/auth/actor.ts";
import { LoginLimiter } from "../../src/auth/limiter.ts";
import { Passwords } from "../../src/auth/password.ts";
import { PreviewGate } from "../../src/net/gate.ts";
import type { EntryPassword, RouteEntry } from "../../src/routing/table.ts";
import { MemorySettingsStore, Settings } from "../../src/settings.ts";
import { silentLogger } from "./logger.ts";
import { ACTOR, setupPreviewContext } from "./preview-context.ts";

export const passwords = new Passwords({ ln: 10 });
export const HOST = "shop.preview.example.dev";
export const APP_ORIGIN = "https://app.preview.example.dev";

export const entry = (password: EntryPassword, over: Partial<RouteEntry> = {}): RouteEntry => ({
  hostname: HOST,
  previewId: "01SHOP0000000000000000000A",
  hostId: "local",
  project: "gw-shop",
  service: "web",
  containerPort: 80,
  upstreamHost: "127.0.0.1",
  upstreamPort: 31000,
  primary: true,
  visibility: "public",
  password,
  passwordLogin: "off",
  state: "awake",
  inflight: 0,
  bytesInFlight: 0,
  lastSeenAt: 0,
  ...over,
});

/** A gate with a movable clock that records why each password attempt failed. */
export function makeGate(
  o: { shared?: { hash: string; salt: string } | null; limiter?: LoginLimiter } = {},
) {
  let now = 1_700_000_000_000;
  const failures: string[] = [];
  const gate = new PreviewGate({
    key: randomBytes(32),
    appOrigin: () => APP_ORIGIN,
    now: () => now,
    sharedPassword: () => o.shared ?? null,
    passwords,
    limiter: o.limiter ?? new LoginLimiter(),
    onPasswordFailure: (_e, _ip, reason) => failures.push(reason),
  });
  const get = (e: RouteEntry, path = "/", headers: Record<string, string> = {}) =>
    gate.handle(
      e,
      new Request(`https://${HOST}${path}`, {
        headers: { "sec-fetch-mode": "navigate", ...headers },
      }),
      "198.51.100.4",
    );
  const post = async (
    e: RouteEntry,
    password: string,
    to = "/",
    headers: Record<string, string> = {},
  ) =>
    gate.handle(
      e,
      new Request(`https://${HOST}/__gangway/password`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: `https://${HOST}`,
          ...headers,
        },
        body: new URLSearchParams({ password, to }).toString(),
      }),
      "198.51.100.4",
    )!;
  const cookieOf = (res: Response) => res.headers.get("set-cookie")?.split(";")[0] ?? "";
  return {
    gate,
    get,
    post,
    cookieOf,
    failures,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

/** A preview context that can hash passwords, with a default mode the test can change. */
export function withPasswords(defaultMode: DefaultPasswordMode = "off") {
  const s = setupPreviewContext();
  const mode = { value: defaultMode };
  s.ctx.passwords = { passwords, defaultMode: () => mode.value };
  const image = { kind: "image" as const, image: "traefik/whoami:v1.10", port: 80 };
  return { ...s, mode, image };
}

const apiAs = (actor: Actor) => {
  const api = new Hono<AppEnv>();
  api.onError(errorHandler(silentLogger()));
  api.use(async (c, next) => {
    c.set("requestId", "r");
    c.set("actor", actor);
    return next();
  });
  const put = (path: string, body: unknown) =>
    api.request(path, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { api, put };
};

/** The preview routes over `withPasswords`, as `actor`. */
export function previewPasswordApi(actor: Actor = ACTOR) {
  const t = withPasswords();
  const { api, put } = apiAs(actor);
  previewRoutes(api, t.ctx, null as never);
  return {
    ...t,
    put: (id: string, body: unknown) => put(`/previews/${id}/password`, body),
    putTitle: (id: string, body: unknown) => put(`/previews/${id}/title`, body),
  };
}

/** The settings routes over in-memory settings, recording what they audit. */
export function settingsPasswordApi() {
  const settings = new Settings({}, new MemorySettingsStore());
  const records: unknown[] = [];
  const { api, put } = apiAs(ACTOR);
  settingsRoutes(
    api,
    settings,
    {
      record: (...a: unknown[]) => {
        records.push(a);
      },
    },
    undefined,
    (p) => passwords.hash(p),
  );
  return { settings, put, records };
}
