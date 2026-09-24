import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config.ts";
import { MemorySettingsStore, SETTINGS, Settings } from "../../src/settings.ts";

const mk = (overrides: Record<string, unknown> = {}) => {
  const store = new MemorySettingsStore();
  return { settings: new Settings(overrides, store), store };
};

describe("precedence: config ?? database ?? default", () => {
  test("default when nothing is set", () => {
    const { settings } = mk();
    const e = settings.effective(SETTINGS.surfacesMcp);
    expect(e.value).toBe(false);
    expect(e.source).toBe("default");
    expect(e.managedByConfig).toBe(false);
  });

  test("database beats default", () => {
    const { settings, store } = mk();
    store.set("surfaces.mcp", true);
    const e = settings.effective(SETTINGS.surfacesMcp);
    expect(e.value).toBe(true);
    expect(e.source).toBe("database");
  });

  test("config beats database", () => {
    const { settings, store } = mk({ "surfaces.mcp": false });
    store.set("surfaces.mcp", true);
    const e = settings.effective(SETTINGS.surfacesMcp);
    expect(e.value).toBe(false);
    expect(e.source).toBe("config");
    expect(e.managedByConfig).toBe(true);
  });

  test("the database value is preserved, not destroyed, while config wins", () => {
    const store = new MemorySettingsStore();
    store.set("surfaces.mcp", true);
    expect(new Settings({ "surfaces.mcp": false }, store).get(SETTINGS.surfacesMcp)).toBe(false);
    expect(new Settings({}, store).get(SETTINGS.surfacesMcp)).toBe(true);
  });
});

describe("writes", () => {
  test("a config-pinned setting refuses runtime writes", () => {
    const { settings } = mk({ "surfaces.ui": true });
    expect(() => settings.set(SETTINGS.surfacesUi, false)).toThrow(/managed by config/);
  });

  test("an unpinned setting writes through and validates", () => {
    const { settings } = mk();
    settings.set(SETTINGS.templatePr, "staging");
    expect(settings.get(SETTINGS.templatePr)).toBe("staging");
    expect(() => settings.set(SETTINGS.templatePr, "Not A Slug")).toThrow();
  });
});

describe("invalid values", () => {
  test("an invalid config override throws rather than falling through", () => {
    const { settings } = mk({ "surfaces.mcp": "yes-please" });
    expect(() => settings.effective(SETTINGS.surfacesMcp)).toThrow(/invalid/);
  });

  test("a corrupt database row falls back to the default instead of crashing", () => {
    const { settings, store } = mk();
    store.set("templates.default.pr", "not a slug");
    const e = settings.effective(SETTINGS.templatePr);
    expect(e.value).toBe("default");
    expect(e.source).toBe("default");
  });
});

describe("loadConfig", () => {
  test("ports and addresses come from the environment", () => {
    const c = loadConfig({
      GANGWAY_LISTEN_PORT: "443",
      GANGWAY_PUBLIC_PORT: "443",
      GANGWAY_LISTEN_ADDRESS: "10.0.0.5",
    });
    expect(c.listenPort).toBe(443);
    expect(c.publicPort).toBe(443);
    expect(c.listenAddress).toBe("10.0.0.5");
  });

  test("dev defaults do not claim :443", () => {
    const c = loadConfig({});
    expect(c.listenPort).toBe(8443);
    expect(c.listenAddress).toBe("::");
  });

  test("an empty GANGWAY_LISTEN_HTTP_PORT disables the redirect listener", () => {
    expect(loadConfig({ GANGWAY_LISTEN_HTTP_PORT: "" }).listenHttpPort).toBeNull();
  });

  test("surface env vars become config overrides and coerce booleans", () => {
    const c = loadConfig({
      GANGWAY_SURFACE_MCP: "false",
      GANGWAY_BASE_DOMAIN: "preview.example.com",
    });
    expect(c.overrides["surfaces.mcp"]).toBe(false);
    expect(c.overrides["baseDomain"]).toBe("preview.example.com");

    const s = new Settings(c.overrides, new MemorySettingsStore());
    expect(s.effective(SETTINGS.surfacesMcp).managedByConfig).toBe(true);
    expect(s.get(SETTINGS.baseDomain)).toBe("preview.example.com");
  });

  test("preview limits have safe defaults and come from the environment", () => {
    const defaults = new Settings({}, new MemorySettingsStore());
    expect(defaults.get(SETTINGS.previewsMemory)).toBe("2g");
    expect(defaults.get(SETTINGS.previewsCpus)).toBe(0);
    expect(defaults.get(SETTINGS.previewsPids)).toBe(1024);

    const c = loadConfig({
      GANGWAY_PREVIEW_MEMORY: "512m",
      GANGWAY_PREVIEW_CPUS: "1.5",
      GANGWAY_PREVIEW_PIDS: "0",
    });
    const s = new Settings(c.overrides, new MemorySettingsStore());
    expect(s.get(SETTINGS.previewsMemory)).toBe("512m");
    expect(s.get(SETTINGS.previewsCpus)).toBe(1.5);
    expect(s.get(SETTINGS.previewsPids)).toBe(0);

    const bad = new Settings(
      loadConfig({ GANGWAY_PREVIEW_MEMORY: "lots" }).overrides,
      new MemorySettingsStore(),
    );
    expect(() => bad.get(SETTINGS.previewsMemory)).toThrow(/previews.limits.memory/);
  });

  test("the default local host carries the port pool and a direct dialer", () => {
    const h = loadConfig({}).hosts[0]!;
    expect(h.id).toBe("local");
    expect(h.upstreamDial).toBe("direct");
    expect(h.portRangeStart).toBe(31000);
    expect(h.portRangeEnd).toBe(31499);
  });

  test("an invalid port is rejected loudly", () => {
    expect(() => loadConfig({ GANGWAY_LISTEN_PORT: "99999" })).toThrow();
  });

  test("ACME defaults to staging", () => {
    const s = new Settings({}, new MemorySettingsStore());
    expect(s.get(SETTINGS.acmeDirectoryUrl)).toContain("staging");
  });
});

describe("secrets in the view", () => {
  test("reports a secret as set or not, never its value; a plain setting keeps its value", () => {
    const { settings } = mk({ "github.appId": "12345" });
    settings.set(
      SETTINGS.githubPrivateKey,
      "-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----",
    );
    const view = Object.fromEntries(settings.view().map((v) => [v.key, v]));
    expect(view["github.privateKey"]).toMatchObject({
      secret: true,
      value: null,
      set: true,
      source: "database",
    });
    expect(view["github.webhookSecret"]).toMatchObject({
      secret: true,
      value: null,
      set: false,
      source: "default",
    });
    expect(view["acme.cloudflare.apiToken"]).toMatchObject({ secret: true, value: null });
    expect(view["github.appId"]).toMatchObject({
      secret: false,
      value: "12345",
      set: true,
      source: "config",
      managedByConfig: true,
    });
    expect(view["templates.default.pr"]).toMatchObject({
      secret: false,
      value: "default",
      set: true,
    });
    expect(settings.get(SETTINGS.githubPrivateKey)).toBe(
      "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
    );
    expect(JSON.stringify(settings.view())).not.toContain("abc");
  });
});
