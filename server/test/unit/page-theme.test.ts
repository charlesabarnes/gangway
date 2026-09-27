import { describe, expect, test } from "bun:test";
import { unknownPage } from "../../src/net/error-pages.ts";
import { passwordPage } from "../../src/net/gate-pages.ts";
import { themeChoice, themed } from "../../src/net/page-chrome.ts";

const req = (cookie?: string) =>
  new Request("https://shop.preview.example.com/", cookie ? { headers: { cookie } } : {});

describe("gangway's own pages follow the shared theme", () => {
  test("reads light or dark from the gw-theme cookie, and nothing else", () => {
    expect(themeChoice(req("a=1; gw-theme=dark"))).toBe("dark");
    expect(themeChoice(req("gw-theme=light"))).toBe("light");
    expect(themeChoice(req("gw-theme=blue"))).toBeNull();
    expect(themeChoice(req("xgw-theme=dark"))).toBeNull();
    expect(themeChoice(req())).toBeNull();
  });

  test("dark forces the dark tokens and hides the light mark", async () => {
    const html = await (
      await themed(unknownPage("x.preview.example.com"), req("gw-theme=dark"))
    ).text();
    expect(html).not.toContain("prefers-color-scheme");
    expect(html).toContain("@media all{:root{--paper:oklch(0.2");
    expect(html).toContain("@media not all{.on-dark");
  });

  test("light keeps the light tokens even on a dark OS, status and headers intact", async () => {
    const page = passwordPage("x.preview.example.com", "/", null, 401);
    const csp = page.headers.get("content-security-policy");
    const out = await themed(page, req("gw-theme=light"));
    const html = await out.text();
    expect(out.status).toBe(401);
    expect(out.headers.get("content-security-policy")).toBe(csp);
    expect(html).toContain("@media not all{:root{--paper:oklch(0.2");
    expect(html).toContain("color-scheme:light;");
  });

  test("with no choice, or a response gangway did not build, nothing changes", async () => {
    const own = unknownPage("x.preview.example.com");
    expect(await themed(own, req())).toBe(own);
    const theirs = new Response("@media (prefers-color-scheme:dark){}");
    expect(await themed(theirs, req("gw-theme=dark"))).toBe(theirs);
  });
});
