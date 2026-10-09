import { describe, expect, test } from "bun:test";
import { HOME_ORG_ID, OrgsRepo } from "../../src/db/repos/orgs.ts";
import { SqliteOrgSettingsStore, SqliteSettingsStore } from "../../src/db/repos/index.ts";
import { MemorySettingsStore, SETTINGS, Settings } from "../../src/settings.ts";
import { MemoryOrgSettingsStore } from "../../src/settings-org.ts";
import { acrossOrgs, beforeOrg, withOrg } from "../../src/tenancy/scope.ts";
import { tempDb } from "../helpers/db.ts";

const HOME = "home";

const mk = (overrides: Record<string, unknown> = {}) => {
  const store = new MemorySettingsStore();
  const orgs = new MemoryOrgSettingsStore();
  return { settings: new Settings(overrides, store, { store: orgs, home: HOME }), store, orgs };
};

describe("an org's own settings", () => {
  test("org B's value is B's alone: the home org and org A keep the server's", () => {
    const { settings } = mk();
    settings.set(SETTINGS.previewWatermark, false, "b");
    expect(settings.get(SETTINGS.previewWatermark, "b")).toBe(false);
    expect(settings.get(SETTINGS.previewWatermark, "a")).toBe(true);
    expect(settings.get(SETTINGS.previewWatermark, HOME)).toBe(true);
    expect(settings.get(SETTINGS.previewWatermark)).toBe(true);
  });

  test("org value, then the server's, then the default; config pins every org", () => {
    const { settings, store, orgs } = mk({ "previews.share.maxTtl": "2h" });
    expect(settings.effective(SETTINGS.templatePr, "b")).toMatchObject({
      value: "default",
      source: "default",
    });
    store.set("templates.default.pr", "server");
    // To another org the server's value is its default, until it sets its own.
    expect(settings.effective(SETTINGS.templatePr, "b")).toMatchObject({
      value: "server",
      source: "default",
    });
    expect(settings.effective(SETTINGS.templatePr, HOME).source).toBe("database");
    orgs.set("b", "templates.default.pr", "mine");
    expect(settings.effective(SETTINGS.templatePr, "b")).toMatchObject({
      value: "mine",
      source: "database",
    });
    orgs.set("b", "previews.share.maxTtl", "9d");
    expect(settings.effective(SETTINGS.previewsShareMaxTtl, "b")).toMatchObject({
      value: "2h",
      source: "config",
    });
    expect(() => {
      settings.set(SETTINGS.previewsShareMaxTtl, "1h", "b");
    }).toThrow(/managed by config/);
  });

  test("the home org writes the server's settings, as before orgs existed", () => {
    const { settings, store, orgs } = mk();
    withOrg(HOME, () => {
      settings.set(SETTINGS.artifactTheme, "brand");
    });
    expect(store.get("artifacts.theme")).toBe("brand");
    expect(orgs.get(HOME, "artifacts.theme")).toBeUndefined();
  });

  test("the request's org is the one read and written when none is named", () => {
    const { settings, store, orgs } = mk();
    withOrg("b", () => {
      settings.set(SETTINGS.previewsActivePerUser, 3);
      expect(settings.get(SETTINGS.previewsActivePerUser)).toBe(3);
    });
    expect(orgs.get("b", "previews.limits.activePerUser")).toBe(3);
    expect(store.get("previews.limits.activePerUser")).toBeUndefined();
    expect(withOrg("a", () => settings.get(SETTINGS.previewsActivePerUser))).toBe(20);
    // Work across every org, and a request before its org is known, read the server's.
    expect(acrossOrgs(() => settings.get(SETTINGS.previewsActivePerUser))).toBe(20);
    expect(beforeOrg(() => settings.get(SETTINGS.previewsActivePerUser))).toBe(20);
  });

  test("another org may not change a server setting, and reads the server's", () => {
    const { settings, store } = mk();
    store.set("previews.limits.memory", "2g");
    expect(() => {
      withOrg("b", () => {
        settings.set(SETTINGS.previewsMemory, "8g");
      });
    }).toThrow(/only the home org/);
    expect(() => {
      settings.set(SETTINGS.previewWatermarkReport, "", "b");
    }).toThrow(/only the home org/);
    expect(withOrg("b", () => settings.get(SETTINGS.previewsMemory))).toBe("2g");
    expect(store.get("previews.limits.memory")).toBe("2g");
  });

  test("another org's view holds only its own settings; the home org's holds them all", () => {
    const { settings } = mk();
    const home = withOrg(HOME, () => settings.view());
    const b = withOrg("b", () => settings.view());
    expect(home.length).toBe(Object.keys(SETTINGS).length);
    expect(b.length).toBeGreaterThan(0);
    expect(b.every((v) => v.scope === "org")).toBe(true);
    expect(b.map((v) => v.key)).not.toContain("baseDomain");
    expect(b.map((v) => v.key)).not.toContain("previews.watermark.report");
    expect(home.find((v) => v.key === "baseDomain")?.scope).toBe("instance");
  });

  test("a server without an org store reads and writes as it always did", () => {
    const store = new MemorySettingsStore();
    const settings = new Settings({}, store);
    withOrg("b", () => {
      settings.set(SETTINGS.previewWatermark, false);
    });
    expect(store.get("previews.watermark")).toBe(false);
  });
});

describe("org settings over SQLite", () => {
  test("rows are per org, cached until a write, and go with their org", () => {
    const { db } = tempDb();
    const b = new OrgsRepo(db).create({ id: "orgb", slug: "bee", name: "Bee" });
    const store = new SqliteSettingsStore(db);
    const own = new SqliteOrgSettingsStore(db);
    const settings = new Settings({}, store, { store: own, home: HOME_ORG_ID });

    settings.set(SETTINGS.previewPasswordMode, "generated", b.id);
    expect(settings.get(SETTINGS.previewPasswordMode, b.id)).toBe("generated");
    expect(settings.get(SETTINGS.previewPasswordMode, HOME_ORG_ID)).toBe("off");
    settings.set(SETTINGS.previewPasswordMode, "shared", b.id);
    expect(settings.get(SETTINGS.previewPasswordMode, b.id)).toBe("shared");
    expect(db.query("SELECT org_id, key, value_json FROM org_settings")).toEqual([
      { org_id: b.id, key: "previews.password.mode", value_json: '"shared"' },
    ]);
    own.delete(b.id, "previews.password.mode");
    expect(settings.get(SETTINGS.previewPasswordMode, b.id)).toBe("off");
  });
});
