import { describe, expect, test } from "bun:test";
import { updateRoutes } from "../../src/app/routes/updates.ts";
import { loadConfig } from "../../src/config.ts";
import { MemorySettingsStore, SETTINGS, Settings } from "../../src/settings.ts";
import { LATEST_RELEASE_URL, UpdateCheck, isNewer, parseVersion } from "../../src/updates.ts";
import { PASSWORD, setupAccounts } from "../helpers/accounts.ts";
import { signedInApp } from "../helpers/http.ts";
import { silentLogger } from "../helpers/logger.ts";

const RELEASE = {
  tag_name: "v0.2.0",
  html_url: "https://github.com/charlesabarnes/gangway/releases/tag/v0.2.0",
};

function fakeGitHub(respond: () => Response | Promise<Response> = () => Response.json(RELEASE)) {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(respond());
    },
  };
}

function make(current: string, respond?: () => Response | Promise<Response>) {
  const settings = new Settings({}, new MemorySettingsStore());
  const gh = fakeGitHub(respond);
  const updates = new UpdateCheck({
    current,
    enabled: () => settings.get(SETTINGS.updatesCheck),
    logger: silentLogger(),
    fetch: gh.fetch,
    now: () => Date.UTC(2026, 8, 24),
  });
  return { settings, gh, updates };
}

describe("version comparison", () => {
  test("reads X.Y.Z with or without a v, and nothing else", () => {
    expect(parseVersion("0.1.0")).toEqual([0, 1, 0]);
    expect(parseVersion("v10.20.30")).toEqual([10, 20, 30]);
    for (const v of ["edge", "dev", "1.2", "1.2.3-rc.1", ""]) expect(parseVersion(v)).toBeNull();
  });

  test.each([
    ["0.2.0", "0.1.0", true],
    ["0.1.10", "0.1.9", true],
    ["1.0.0", "0.99.99", true],
    ["0.1.0", "0.1.0", false],
    ["0.1.0", "0.2.0", false],
    ["0.2.0", "edge", false],
    ["0.2.0", "dev", false],
    ["nightly", "0.1.0", false],
  ])("%s over %s is %p", (latest, current, want) => {
    expect(isNewer(latest, current)).toBe(want);
  });
});

describe("UpdateCheck", () => {
  test("before any check it reports only the running version", () => {
    expect(make("0.1.0").updates.status()).toEqual({
      current: "0.1.0",
      enabled: true,
      latest: null,
      available: false,
      url: null,
      checkedAt: null,
    });
  });

  test("a newer release is available, with its notes, asked for with a User-Agent", async () => {
    const { updates, gh } = make("0.1.0");
    await updates.check();
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]!.url).toBe(LATEST_RELEASE_URL);
    expect(new Headers(gh.calls[0]!.init.headers).get("user-agent")).toBe("gangway/0.1.0");
    expect(updates.status()).toEqual({
      current: "0.1.0",
      enabled: true,
      latest: "0.2.0",
      available: true,
      url: RELEASE.html_url,
      checkedAt: "2026-09-24T00:00:00.000Z",
    });
  });

  test("edge and dev builds see the latest release but are never told to update", async () => {
    for (const current of ["edge", "dev"]) {
      const { updates } = make(current);
      await updates.check();
      expect(updates.status()).toMatchObject({ current, latest: "0.2.0", available: false });
    }
  });

  test("the running release is not an update", async () => {
    const { updates } = make("0.2.0");
    await updates.check();
    expect(updates.status()).toMatchObject({ latest: "0.2.0", available: false });
  });

  test("turned off, it makes no request and reports nothing it learned before", async () => {
    const { updates, settings, gh } = make("0.1.0");
    await updates.check();
    settings.set(SETTINGS.updatesCheck, false);
    await updates.check();
    expect(gh.calls).toHaveLength(1);
    expect(updates.status()).toEqual({
      current: "0.1.0",
      enabled: false,
      latest: null,
      available: false,
      url: null,
      checkedAt: null,
    });
  });

  test.each([
    ["an error status", () => new Response("rate limited", { status: 403 })],
    ["a body that is not a release", () => Response.json({ message: "Not Found" })],
    [
      "a network failure",
      () => {
        throw new Error("getaddrinfo ENOTFOUND api.github.com");
      },
    ],
  ])("%s never throws and keeps the last good result", async (_, fail) => {
    let failing = false;
    const { updates } = make("0.1.0", () => (failing ? fail() : Response.json(RELEASE)));
    await updates.check();
    failing = true;
    await updates.check();
    expect(updates.status()).toMatchObject({ latest: "0.2.0", available: true });
  });
});

describe("config", () => {
  test("the version comes from GANGWAY_VERSION, else dev", () => {
    expect(loadConfig({}).version).toBe("dev");
    expect(loadConfig({ GANGWAY_VERSION: "0.3.1" }).version).toBe("0.3.1");
  });

  test("GANGWAY_UPDATE_CHECK=false pins the check off", () => {
    const s = new Settings(
      loadConfig({ GANGWAY_UPDATE_CHECK: "false" }).overrides,
      new MemorySettingsStore(),
    );
    expect(s.effective(SETTINGS.updatesCheck)).toMatchObject({
      value: false,
      managedByConfig: true,
    });
    expect(new Settings({}, new MemorySettingsStore()).get(SETTINGS.updatesCheck)).toBe(true);
  });
});

describe("GET /v1/updates", () => {
  test("needs settings.read and returns the status", async () => {
    const s = setupAccounts();
    const { updates } = make("0.1.0");
    await updates.check();
    const { call, login, ada } = await signedInApp(s, {
      envToken: "gw_updates_env_token_0123456789abcdef",
      v1: (api) => updateRoutes(api, updates),
    });

    const res = await call("/v1/updates", { as: ada });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ current: "0.1.0", latest: "0.2.0", available: true });

    await s.accounts.createUser(
      {
        kind: "token",
        tokenId: "system:test",
        scopes: ["admin"],
        permissions: new Set(["users.manage"]),
      } as never,
      { email: "vi@example.com", password: PASSWORD, roleId: "viewer" },
    );
    const vi = await login("vi@example.com");
    expect((await call("/v1/updates", { as: vi })).status).toBe(403);
  });
});
