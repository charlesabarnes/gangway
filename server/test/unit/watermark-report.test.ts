import { describe, expect, test } from "bun:test";
import { watermarkFor, type NetworkDeps } from "../../src/boot/network.ts";
import { loadConfig } from "../../src/config.ts";
import { MemorySettingsStore, SETTINGS, Settings } from "../../src/settings.ts";
import type { RouteEntry } from "../../src/routing/table.ts";

const REPORT = "https://cloud.example.com/report";

function watermark(o: { overrides?: Record<string, unknown>; choice?: boolean | null }) {
  const settings = new Settings(o.overrides ?? {}, new MemorySettingsStore());
  const ctx = {
    previews: { watermarkOf: () => o.choice ?? null },
  } as unknown as NetworkDeps["ctx"];
  return watermarkFor({ ctx, settings } as unknown as NetworkDeps);
}
const at = (hostname: string) => ({ hostname, previewId: "p1" }) as RouteEntry;

describe("what a preview's pages carry", () => {
  test("the mark when it is on, wherever the preview lives", () => {
    const w = watermark({ overrides: { "previews.watermark.report": REPORT } });
    expect(w.mode(at("shop.example.com"))).toBe("mark");
  });

  test("with the mark off: the report link under a listed domain, nothing elsewhere", () => {
    const w = watermark({
      choice: false,
      overrides: {
        "previews.watermark.report": REPORT,
        "previews.report.domains": ["acme.gway.app"],
      },
    });
    expect(w.mode(at("shop.acme.gway.app"))).toBe("report");
    expect(w.mode(at("acme.gway.app"))).toBe("report");
    expect(w.mode(at("shop.example.com"))).toBeNull();
    expect(w.mode(at("shopacme.gway.app"))).toBeNull();
  });

  test("no report URL, no report link: listed domains change nothing", () => {
    const w = watermark({
      choice: false,
      overrides: { "previews.report.domains": ["acme.gway.app"] },
    });
    expect(w.mode(at("shop.acme.gway.app"))).toBeNull();
    expect(w.script("mark")).not.toContain(String.raw`class=\"report`);
  });

  test("the script carries the report link once a URL is set", () => {
    const w = watermark({ overrides: { "previews.watermark.report": REPORT } });
    expect(w.script("mark")).toContain(`${REPORT}?url=`);
    expect(w.script("report")).toContain("chip only");
    // A new report URL is a new script URL, so browsers drop the cached one.
    expect(w.version()).not.toBe(watermark({}).version());
  });
});

describe("the settings", () => {
  test("come from their environment variables, and are then pinned", () => {
    const config = loadConfig({
      GANGWAY_WATERMARK_REPORT_URL: REPORT,
      GANGWAY_REPORT_DOMAINS: "Acme.gway.app, other.example.com",
    });
    const settings = new Settings(config.overrides, new MemorySettingsStore());
    expect(settings.get(SETTINGS.previewWatermarkReport)).toBe(REPORT);
    expect(settings.get(SETTINGS.previewReportDomains)).toEqual([
      "acme.gway.app",
      "other.example.com",
    ]);
    const row = settings.view().find((s) => s.key === "previews.report.domains");
    expect(row?.managedByConfig).toBe(true);
  });

  test("refuse a report URL that is not https, and a domain that is not a hostname", () => {
    const url = SETTINGS.previewWatermarkReport.schema;
    const domains = SETTINGS.previewReportDomains.schema;
    expect(url.safeParse("http://x.example.com/r").success).toBe(false);
    expect(url.safeParse("").success).toBe(true);
    expect(domains.safeParse(["bad domain"]).success).toBe(false);
    expect(domains.safeParse(["gway.app"]).success).toBe(true);
  });
});
